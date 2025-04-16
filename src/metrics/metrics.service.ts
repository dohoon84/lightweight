import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as fsPromises from 'fs/promises'; // 비동기 fs
import * as fs from 'fs'; // 동기 fs 추가
import * as path from 'path';
import * as os from 'os'; // os 모듈 추가
// Add the import for check-disk-space
import checkDiskSpace from 'check-disk-space';
import * as TOML from '@iarna/toml'; // TOML 파서 추가
import { InfluxDB, Point, WriteApi } from '@influxdata/influxdb-client'; // InfluxDB 클라이언트 추가
import { Interval } from '@nestjs/schedule'; // 스케줄러 추가

// Remove exec import if no longer needed after refactoring
// import { exec } from 'child_process';
// import { promisify } from 'util';

// const execAsync = promisify(exec);

type MetricsTarget = 'container' | 'host';

// 설정 파일 인터페이스 정의 (필요한 부분만)
interface AgentConfig {
  interval: string;
  flush_interval: string;
  metric_batch_size: number;
  metric_buffer_limit: number;
  omit_hostname: boolean;
  hostname?: string; // hostname 추가
}

interface InfluxOutputConfig {
  urls: string[];
  token: string;
  organization: string;
  bucket: string;
}

interface InputConfig {
  percpu?: boolean;
  totalcpu?: boolean;
  ignore_fs?: string[];
  interfaces?: string[];
}

interface MetricsConfig {
  agent: AgentConfig;
  outputs?: { influxdb_v2?: InfluxOutputConfig };
  inputs?: {
    cpu?: InputConfig;
    mem?: InputConfig; // 비어있지만 존재 여부 확인용
    disk?: InputConfig;
    net?: InputConfig;
  };
}


@Injectable()
// OnModuleInit, OnModuleDestroy 추가
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private readonly metricsTarget: MetricsTarget;
  private readonly hostProcPrefix = '/host/proc'; // Assuming mount point for host /proc
  private config: MetricsConfig; // 설정 저장 변수
  private influxWriteApi: WriteApi | null = null; // InfluxDB 쓰기 API
  private metricsBuffer: Point[] = []; // 메트릭 버퍼
  private hostname: string; // 호스트 이름 저장 변수
  private latestRawMetrics: any | null = null; // 최신 원시 메트릭 저장 변수 추가

  // 스케줄러 인터벌 핸들 저장
  private collectIntervalRef: NodeJS.Timeout | null = null;
  private flushIntervalRef: NodeJS.Timeout | null = null;


  constructor() {
    // Read the target mode from environment variable, default to 'container'
    this.metricsTarget = process.env.METRICS_TARGET === 'host' ? 'host' : 'container';
    this.logger.log(`Metrics target set to: ${this.metricsTarget}`);
    // 생성자에서는 설정 로딩 시도, 실패 시 로그만 남김
    // 실제 로딩 및 초기화는 onModuleInit에서 수행
    try {
      this.loadConfig(); // 설정 로드 시도
      this.initializeHostname(); // 호스트 이름 초기화
    } catch (error) {
      this.logger.error(`Failed to load initial configuration: ${error.message}`);
      this.config = this.getDefaultConfig(); // 기본 설정 사용
      this.initializeHostname(); // 기본 호스트 이름 설정
    }

    if (this.metricsTarget === 'host') {
      this.logger.warn(
        `Running in 'host' mode. Ensure the host's /proc filesystem is mounted read-only at ${this.hostProcPrefix} in the container. (e.g., -v /proc:${this.hostProcPrefix}:ro)`,
      );
      // Also log assumption about root filesystem access for disk usage
      this.logger.warn(
          `Disk usage metrics in 'host' mode will target '/'. Ensure the relevant host filesystem is accessible at this path.`
      );
    }
  }

  // 모듈 초기화 시 설정 로드 및 InfluxDB 클라이언트 설정
  async onModuleInit() {
    try {
      this.loadConfig(); // 설정 파일 로드
      this.initializeHostname(); // 호스트 이름 결정
      this.initializeInfluxDB(); // InfluxDB 클라이언트 초기화
      this.startScheduledTasks(); // 스케줄링된 작업 시작
      this.logger.log('MetricsService initialized successfully.');
    } catch (error) {
      this.logger.error(`Failed to initialize MetricsService: ${error.message}`, error.stack);
      // 초기화 실패 시 에러 처리 (예: 애플리케이션 중단 또는 재시도 로직)
      // 여기서는 로그만 남기고 계속 진행 (기본 설정으로 동작하거나 메트릭 수집 안함)
       if (!this.config) {
         this.config = this.getDefaultConfig();
         this.initializeHostname();
       }
    }
  }

  // 모듈 파괴 시 인터벌 정리
  onModuleDestroy() {
    this.stopScheduledTasks();
    // 필요한 경우 InfluxDB 클라이언트 종료 로직 추가
    if (this.influxWriteApi) {
      this.influxWriteApi.close().then(() => this.logger.log('InfluxDB write API closed.'));
    }
  }

  private loadConfig() {
    const configPath = process.env.CONFIG_PATH || path.resolve('./lightweight-metrics.config');
    this.logger.log(`Loading configuration from: ${configPath}`);
    try {
      // 1. 파일 읽기
      const configFile = fs.readFileSync(configPath, 'utf-8');
      this.logger.log('=== 읽은 파일 내용 (처음 200자) ===');
      this.logger.log(configFile.substring(0, 200) + '...');
      
      // 2. TOML 파싱 시도
      this.logger.log('=== TOML 파싱 시작 ===');
      const parsedConfig = TOML.parse(configFile);
      this.logger.log('TOML 파싱 성공!');
      
      // 3. 파싱된 결과 확인
      this.logger.log('=== 파싱된 설정 구조 ===');
      this.logger.log('파싱된 객체 키들: ' + Object.keys(parsedConfig).join(', '));
      if (parsedConfig.agent) {
        this.logger.log('Agent 설정: ' + JSON.stringify(parsedConfig.agent));
      } else {
        this.logger.log('Agent 설정 없음!');
      }
      
      // 4. InfluxDB 설정 특별 확인
      this.logger.log('=== InfluxDB 설정 확인 ===');
      if (parsedConfig.outputs) {
        this.logger.log('outputs 객체 존재: ' + JSON.stringify(Object.keys(parsedConfig.outputs)));
        
        const outputs = parsedConfig.outputs as { influxdb_v2?: any };
        if (outputs.influxdb_v2) {
          const influx = outputs.influxdb_v2;
          this.logger.log('influxdb_v2 객체 존재!');
          this.logger.log('urls: ' + (influx.urls ? JSON.stringify(influx.urls) : 'undefined') + 
                         ` (${typeof influx.urls}, 배열?: ${Array.isArray(influx.urls)})`);
          this.logger.log('token: ' + (influx.token ? '값 있음 (표시안함)' : 'undefined') + 
                         ` (${typeof influx.token})`);
          this.logger.log('organization: ' + (influx.organization || 'undefined') + 
                         ` (${typeof influx.organization})`);
          this.logger.log('bucket: ' + (influx.bucket || 'undefined') + 
                         ` (${typeof influx.bucket})`);
        } else {
          this.logger.log('influxdb_v2 객체 없음!');
        }
      } else {
        this.logger.log('outputs 객체 없음!');
      }
      
      // 5. 설정 변환 및 검증
      this.logger.log('=== 설정 변환 및 검증 ===');
      this.config = parsedConfig as unknown as MetricsConfig;
      this.logger.log('as unknown as MetricsConfig 타입 변환 완료');
      
      // 6. 필수 설정 검증
      if (!this.config.agent) {
        this.logger.log('agent 설정 누락 오류 발생!');
        throw new Error('Agent configuration is missing.');
      }
      this.logger.log('agent 설정 검증 통과');
      
      // 7. InfluxDB 설정 상세 검증
      if (this.config.outputs?.influxdb_v2) {
        const influxConfig = this.config.outputs.influxdb_v2;
        this.logger.log('InfluxDB 설정 상세 검증:');
        this.logger.log(`- urls 존재 및 배열: ${!!influxConfig.urls && Array.isArray(influxConfig.urls)}`);
        this.logger.log(`- urls 배열 길이 > 0: ${!!influxConfig.urls && influxConfig.urls.length > 0}`);
        this.logger.log(`- token 존재: ${!!influxConfig.token}`);
        this.logger.log(`- organization 존재: ${!!influxConfig.organization}`);
        this.logger.log(`- bucket 존재: ${!!influxConfig.bucket}`);
        
        const isValid = 
          !!influxConfig.urls && 
          Array.isArray(influxConfig.urls) && 
          influxConfig.urls.length > 0 && 
          !!influxConfig.token && 
          !!influxConfig.organization && 
          !!influxConfig.bucket;
          
        this.logger.log(`전체 InfluxDB 설정 유효성: ${isValid}`);
        
        if (!isValid) {
          this.logger.log('InfluxDB 설정 불완전 오류 발생!');
          throw new Error('InfluxDB v2 output configuration is incomplete.');
        }
      }
      
      this.logger.log('설정 로드 및 검증 모두 성공');
    } catch (error) {
      this.logger.error(`설정 파일 로드 또는 파싱 실패 (${configPath}): ${error.message}`);
      if (error.stack) {
        this.logger.error(`스택 트레이스: ${error.stack}`);
      }
      throw error;
    }
  }

  // 기본 설정 반환 함수
  private getDefaultConfig(): MetricsConfig {
      this.logger.warn('Using default configuration as loading failed.');
      return {
          agent: {
              interval: "10s",
              flush_interval: "10s",
              metric_batch_size: 1000,
              metric_buffer_limit: 10000,
              omit_hostname: false,
              hostname: "" // 기본값은 빈 문자열
          },
          // outputs 및 inputs는 기본적으로 비활성화
      };
  }


  private initializeHostname() {
      if (this.config?.agent?.hostname) {
          this.hostname = this.config.agent.hostname;
          this.logger.log(`Using hostname from config: ${this.hostname}`);
      } else {
          this.hostname = os.hostname(); // OS 호스트 이름 사용
          this.logger.log(`Using OS hostname: ${this.hostname}`);
      }
  }


  private initializeInfluxDB() {
    if (!this.config?.outputs?.influxdb_v2) {
      this.logger.warn('InfluxDB output configuration not found. Metrics will not be sent to InfluxDB.');
      this.influxWriteApi = null;
      return;
    }
    const { urls, token, organization, bucket } = this.config.outputs.influxdb_v2;
    if (!urls || urls.length === 0 || !token || !organization || !bucket) {
       this.logger.error('InfluxDB v2 configuration is incomplete. Cannot initialize InfluxDB client.');
       this.influxWriteApi = null;
       return; // 필수 정보 없으면 초기화 중단
    }


    try {
      const influxDB = new InfluxDB({ url: urls[0], token });
      // Set write options for error handling and batching
      const writeOptions = {
          batchSize: this.config.agent.metric_batch_size || 1000,
          flushInterval: this.parseInterval(this.config.agent.flush_interval, 10000) / 1000, // Convert ms to s for client option
          maxRetries: 3, // Example retry config
          maxRetryDelay: 180 * 1000, // Example max retry delay
          retryJitter: 200, // Example jitter
          // Error handling callback
          writeFailed: (error: Error, lines: string[], attempt: number) => {
              this.logger.error(
                  `InfluxDB write failed (attempt ${attempt}): ${error.message}. Failed lines sample: ${lines.slice(0, 2).join('\n')}`,
                   error.stack
              );
          },
          writeSuccess: (lines: string[]) => {
              this.logger.debug(`InfluxDB write successful for ${lines.length} lines.`);
          },
      };

      this.influxWriteApi = influxDB.getWriteApi(organization, bucket, 'ns', writeOptions);
      this.logger.log(`InfluxDB write API initialized for org: ${organization}, bucket: ${bucket} with batchSize: ${writeOptions.batchSize}, flushInterval: ${writeOptions.flushInterval}s`);

      // Set default tags
      this.influxWriteApi.useDefaultTags({ host: this.config.agent.omit_hostname ? '' : this.hostname });

    } catch (error) {
      this.logger.error(`Failed to initialize InfluxDB client: ${error.message}`, error.stack);
      this.influxWriteApi = null;
    }
  }

  // 스케줄링된 작업 시작
  private startScheduledTasks() {
    if (!this.config?.agent) {
        this.logger.error('Agent configuration not loaded. Cannot start scheduled tasks.');
        return;
    }

    const collectIntervalMs = this.parseInterval(this.config.agent.interval, 10000); // 기본 10초
    const flushIntervalMs = this.parseInterval(this.config.agent.flush_interval, 10000); // 기본 10초

    this.logger.log(`Starting metric collection every ${collectIntervalMs}ms`);
    this.collectIntervalRef = setInterval(() => this.collectAndBufferMetrics(), collectIntervalMs);

    this.logger.log(`Starting metric flush every ${flushIntervalMs}ms`);
    this.flushIntervalRef = setInterval(() => this.flushMetricsToInfluxDB(), flushIntervalMs);
  }

  // 스케줄링된 작업 중지
  private stopScheduledTasks() {
      if (this.collectIntervalRef) {
          clearInterval(this.collectIntervalRef);
          this.collectIntervalRef = null;
          this.logger.log('Stopped metric collection interval.');
      }
      if (this.flushIntervalRef) {
          clearInterval(this.flushIntervalRef);
          this.flushIntervalRef = null;
          this.logger.log('Stopped metric flush interval.');
      }
  }


  // 문자열 간격(e.g., "10s", "1m")을 밀리초로 변환
  private parseInterval(intervalString: string, defaultValue: number): number {
    if (!intervalString) return defaultValue;
    const match = intervalString.match(/^(\d+)(s|m|h)$/);
    if (!match) return defaultValue;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
      case 's': return value * 1000;
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      default: return defaultValue;
    }
  }


  // 메트릭 수집 및 버퍼링 (주기적 실행)
  private async collectAndBufferMetrics() {
      if (!this.config) {
          this.logger.warn('Configuration not available, skipping metric collection.');
          return;
      }
      // 버퍼 크기 제한 확인
      if (this.metricsBuffer.length >= this.config.agent.metric_buffer_limit) {
          this.logger.warn(`Metrics buffer full (${this.metricsBuffer.length} points), dropping oldest metrics.`);
          this.metricsBuffer.splice(0, this.metricsBuffer.length - this.config.agent.metric_batch_size + 1);
      }

      try {
          const metrics = await this.getMetrics(); // 기존 메트릭 수집 함수 호출
          this.latestRawMetrics = metrics; // 수집된 원시 메트릭 저장

          // 메트릭 객체를 InfluxDB Point 객체로 변환
          const points = this.convertToInfluxPoints(metrics);

          // 변환된 포인트들을 버퍼에 추가
          this.metricsBuffer.push(...points);
          this.logger.debug(`Collected ${points.length} metric points. Buffer size: ${this.metricsBuffer.length}`);

      } catch (error) {
          this.logger.error(`Error during metric collection: ${error.message}`, error.stack);
          this.latestRawMetrics = { error: `Error collecting metrics: ${error.message}` }; // 에러 발생 시 에러 상태 저장
      }
  }

  // 메트릭을 InfluxDB로 전송 (주기적 실행)
  private flushMetricsToInfluxDB() {
      if (!this.influxWriteApi) {
          // this.logger.debug('InfluxDB client not initialized, skipping flush.');
          // 버퍼가 계속 쌓이는 것을 방지하기 위해, InfluxDB 설정 없으면 버퍼 비우기
          if (this.metricsBuffer.length > 0) {
             // this.logger.warn(`InfluxDB not configured, clearing ${this.metricsBuffer.length} buffered points.`);
              this.metricsBuffer = [];
          }
          return;
      }

      if (this.metricsBuffer.length === 0) {
          // this.logger.debug('Metrics buffer is empty, skipping flush.');
          return;
      }

      const batchSize = this.config?.agent?.metric_batch_size ?? 1000;
      const pointsToSend = this.metricsBuffer.splice(0, Math.min(this.metricsBuffer.length, batchSize));

      if (pointsToSend.length > 0) {
          this.logger.log(`Flushing ${pointsToSend.length} metric points to InfluxDB. Remaining buffer size: ${this.metricsBuffer.length}`);
          try {
              // Write points using the API
              this.influxWriteApi.writePoints(pointsToSend);
              // Flush is handled by the WriteApi based on flushInterval in options, but manual flush can be called if needed
              // await this.influxWriteApi.flush(); // Generally not needed if flushInterval is set
          } catch (error) {
              // This catch block might not be necessary if writeFailed callback handles errors
              this.logger.error(`Error calling writePoints: ${error.message}`, error.stack);
              // Decide how to handle points that failed to be enqueued (e.g., re-add to buffer carefully)
          }
      }
  }


  // 메트릭 객체를 InfluxDB Point 배열로 변환
  private convertToInfluxPoints(metrics: any): Point[] {
    const points: Point[] = [];
    const timestamp = new Date(metrics.timestamp); // ISO 문자열을 Date 객체로

    // 공통 태그 (호스트명은 WriteApi 기본 태그로 설정됨)
    // const commonTags = { host: this.config.agent.omit_hostname ? undefined : this.hostname };

    // CPU 메트릭 변환
    if (metrics.cpu && typeof metrics.cpu === 'object' && !metrics.cpu.error) {
        // 호스트 CPU ('host' mode, /proc/stat 기반)
        if (this.metricsTarget === 'host' && metrics.cpu.source?.includes('/proc/stat')) {
            const cpuPoint = new Point('cpu')
                .timestamp(timestamp)
                // .tag('cpu', 'cpu-total') // 전체 CPU 정보임을 명시
                .intField('user', metrics.cpu.user)
                .intField('nice', metrics.cpu.nice)
                .intField('system', metrics.cpu.system)
                .intField('idle', metrics.cpu.idle)
                .intField('iowait', metrics.cpu.iowait)
                .intField('irq', metrics.cpu.irq)
                .intField('softirq', metrics.cpu.softirq)
                .intField('steal', metrics.cpu.steal)
                .intField('total', metrics.cpu.total) // 집계된 total 값 추가
                .floatField('usage_percent', metrics.cpu.usage_percent ?? 0); // 계산된 사용률
             points.push(cpuPoint);
             // TODO: inputs.cpu.percpu = true 인 경우 개별 코어 처리 로직 추가 (/proc/stat 파싱 확장 필요)
        }
        // 컨테이너 CPU (cgroup v2, cpu.stat)
        else if (metrics.cpu.source?.includes('cpu.stat (v2)')) {
             const cpuPoint = new Point('cpu')
                 .timestamp(timestamp)
                 // .tag('cpu', 'container')
                 .intField('usage_usec', metrics.cpu.usage_usec)
                 .intField('user_usec', metrics.cpu.user_usec)
                 .intField('system_usec', metrics.cpu.system_usec)
                 .intField('nr_periods', metrics.cpu.nr_periods)
                 .intField('nr_throttled', metrics.cpu.nr_throttled)
                 .intField('throttled_usec', metrics.cpu.throttled_usec);
             points.push(cpuPoint);
        }
         // 컨테이너 CPU (cgroup v1, cpuacct.usage)
        else if (metrics.cpu.source?.includes('cpuacct.usage (v1)')) {
             const cpuPoint = new Point('cpu')
                 .timestamp(timestamp)
                 // .tag('cpu', 'container')
                 .intField('usage_total_usec', metrics.cpu.usage_usec); // 필드 이름 명확화
             points.push(cpuPoint);
        }
    }

    // 메모리 메트릭 변환
    if (metrics.memory && typeof metrics.memory === 'object' && !metrics.memory.error) {
         // 호스트 메모리 (/proc/meminfo)
         if (this.metricsTarget === 'host' && metrics.memory.source?.includes('/proc/meminfo')) {
             const memPoint = new Point('mem')
                 .timestamp(timestamp);
             // 주요 필드 추가 (바이트 단위)
             if (metrics.memory.MemTotal) memPoint.intField('total', metrics.memory.MemTotal);
             if (metrics.memory.MemFree) memPoint.intField('free', metrics.memory.MemFree);
             if (metrics.memory.MemAvailable) memPoint.intField('available', metrics.memory.MemAvailable);
             if (metrics.memory.Buffers) memPoint.intField('buffers', metrics.memory.Buffers);
             if (metrics.memory.Cached) memPoint.intField('cached', metrics.memory.Cached);
             if (metrics.memory.SwapTotal) memPoint.intField('swap_total', metrics.memory.SwapTotal);
             if (metrics.memory.SwapFree) memPoint.intField('swap_free', metrics.memory.SwapFree);
             // 계산된 값
              if (metrics.memory.MemUsed) memPoint.intField('used', metrics.memory.MemUsed);
              if (metrics.memory.MemUsedPercent) memPoint.floatField('used_percent', metrics.memory.MemUsedPercent);
              if (metrics.memory.MemUsedActual) memPoint.intField('used_actual', metrics.memory.MemUsedActual);
              if (metrics.memory.MemUsedPercentActual) memPoint.floatField('used_percent_actual', metrics.memory.MemUsedPercentActual);

             points.push(memPoint);
         }
         // 컨테이너 메모리 (cgroup memory.stat, memory.current 등)
         else if (metrics.memory.source?.includes('cgroup')) {
             const memPoint = new Point('mem')
                 .timestamp(timestamp);
                 // .tag('mem_type', 'container');
             // cgroup v2 (memory.current, memory.stat)
             if (metrics.memory.current) memPoint.intField('usage', metrics.memory.current); // memory.current 값
             if (metrics.memory.limit_bytes) memPoint.intField('limit', metrics.memory.limit_bytes); // memory.max 또는 memory.limit_in_bytes
             if (metrics.memory.stat) { // memory.stat 내부 값들
                  if (metrics.memory.stat.rss) memPoint.intField('rss', metrics.memory.stat.rss);
                  if (metrics.memory.stat.cache) memPoint.intField('cache', metrics.memory.stat.cache);
                  // 기타 필요한 stat 값 추가
             }
             // cgroup v1 (memory.usage_in_bytes, memory.limit_in_bytes, memory.stat)
             // 필요 시 v1 필드 추가

             // 사용률 계산 (limit이 있는 경우)
             if (metrics.memory.current && metrics.memory.limit_bytes && metrics.memory.limit_bytes > 0) {
                 memPoint.floatField('usage_percent', (metrics.memory.current / metrics.memory.limit_bytes) * 100);
             }
             points.push(memPoint);
         }
    }

    // 디스크 I/O 메트릭 변환
    if (metrics.diskIO && typeof metrics.diskIO === 'object') {
        Object.keys(metrics.diskIO).forEach(device => {
            const deviceStats = metrics.diskIO[device];
            if (typeof deviceStats === 'object' && !deviceStats.error) {
                 const diskPoint = new Point('diskio')
                    .timestamp(timestamp)
                    .tag('device', device); // 디바이스 태그 추가
                 // 필드 추가 (null/undefined 체크 추가)
                 if (deviceStats.reads_completed !== undefined) diskPoint.intField('reads', deviceStats.reads_completed);
                 if (deviceStats.reads_merged !== undefined) diskPoint.intField('reads_merged', deviceStats.reads_merged);
                 if (deviceStats.sectors_read !== undefined) diskPoint.intField('sectors_read', deviceStats.sectors_read);
                 if (deviceStats.read_time_ms !== undefined) diskPoint.intField('read_time', deviceStats.read_time_ms); // 단위를 필드 이름에 명시하지 않음 (ms)
                 if (deviceStats.writes_completed !== undefined) diskPoint.intField('writes', deviceStats.writes_completed);
                 if (deviceStats.writes_merged !== undefined) diskPoint.intField('writes_merged', deviceStats.writes_merged);
                 if (deviceStats.sectors_written !== undefined) diskPoint.intField('sectors_written', deviceStats.sectors_written);
                 if (deviceStats.write_time_ms !== undefined) diskPoint.intField('write_time', deviceStats.write_time_ms); // (ms)
                 if (deviceStats.io_in_progress !== undefined) diskPoint.intField('io_progress', deviceStats.io_in_progress);
                 if (deviceStats.io_time_ms !== undefined) diskPoint.intField('io_time', deviceStats.io_time_ms); // (ms)
                 if (deviceStats.weighted_io_time_ms !== undefined) diskPoint.intField('weighted_io_time', deviceStats.weighted_io_time_ms); // (ms)
                 // cgroup blkio 통계 필드 (존재하는 경우)
                  if (deviceStats.io_service_bytes_recursive_read !== undefined) diskPoint.intField('read_bytes', deviceStats.io_service_bytes_recursive_read);
                  if (deviceStats.io_service_bytes_recursive_write !== undefined) diskPoint.intField('write_bytes', deviceStats.io_service_bytes_recursive_write);
                  if (deviceStats.io_serviced_recursive_read !== undefined) diskPoint.intField('read_ops', deviceStats.io_serviced_recursive_read);
                  if (deviceStats.io_serviced_recursive_write !== undefined) diskPoint.intField('write_ops', deviceStats.io_serviced_recursive_write);

                 points.push(diskPoint);
            }
        });
    }

     // 디스크 사용량 메트릭 변환
    if (metrics.diskUsage && typeof metrics.diskUsage === 'object') {
         Object.keys(metrics.diskUsage).forEach(mountPoint => {
             const usageStats = metrics.diskUsage[mountPoint];
             if (typeof usageStats === 'object' && !usageStats.error) {
                 const diskUsagePoint = new Point('disk')
                     .timestamp(timestamp)
                     .tag('path', mountPoint); // 마운트 경로 태그 추가
                 // 필드 추가 (bytes 단위)
                 if (usageStats.size !== undefined) diskUsagePoint.intField('total', usageStats.size);
                 if (usageStats.free !== undefined) diskUsagePoint.intField('free', usageStats.free);
                 if (usageStats.used !== undefined) diskUsagePoint.intField('used', usageStats.used); // 계산된 used 값
                 // 사용률 추가
                 if (usageStats.usagePercent !== undefined) diskUsagePoint.floatField('used_percent', usageStats.usagePercent);

                 points.push(diskUsagePoint);
             }
         });
     }


    // 네트워크 메트릭 변환
    if (metrics.network && typeof metrics.network === 'object') {
        Object.keys(metrics.network).forEach(interfaceName => {
            const netStats = metrics.network[interfaceName];
            if (typeof netStats === 'object' && !netStats.error) {
                 const netPoint = new Point('net')
                    .timestamp(timestamp)
                    .tag('interface', interfaceName); // 인터페이스 태그 추가
                // 필드 추가 (null/undefined 체크 추가)
                 if (netStats.rx_bytes !== undefined) netPoint.intField('bytes_recv', netStats.rx_bytes);
                 if (netStats.rx_packets !== undefined) netPoint.intField('packets_recv', netStats.rx_packets);
                 if (netStats.rx_errors !== undefined) netPoint.intField('err_in', netStats.rx_errors);
                 if (netStats.rx_dropped !== undefined) netPoint.intField('drop_in', netStats.rx_dropped);
                 if (netStats.tx_bytes !== undefined) netPoint.intField('bytes_sent', netStats.tx_bytes);
                 if (netStats.tx_packets !== undefined) netPoint.intField('packets_sent', netStats.tx_packets);
                 if (netStats.tx_errors !== undefined) netPoint.intField('err_out', netStats.tx_errors);
                 if (netStats.tx_dropped !== undefined) netPoint.intField('drop_out', netStats.tx_dropped);

                 points.push(netPoint);
            }
        });
    }

    return points;
}


  // Renamed from getContainerMetrics
  // 설정 파일을 기반으로 필요한 메트릭만 수집하도록 수정
  async getMetrics(): Promise<any> {
     if (!this.config || !this.config.inputs) {
        this.logger.warn('Input configuration is missing. No metrics will be collected.');
        return { timestamp: new Date().toISOString(), target: this.metricsTarget, error: 'Input configuration missing' };
     }

     const { inputs } = this.config;
     const promises = [];
     const results = {
        cpu: undefined,
        memory: undefined,
        diskIO: undefined,
        diskUsage: undefined,
        network: undefined,
     };

     // 설정에 따라 프로미스 추가
     if (inputs.cpu) promises.push(this.getCpuStats(inputs.cpu).then(r => results.cpu = r));
     if (inputs.mem) promises.push(this.getMemoryStats(inputs.mem).then(r => results.memory = r)); // inputs.mem 존재 여부만 확인
     // 디스크 IO와 사용량은 inputs.disk 설정 하나로 제어
     if (inputs.disk) {
        promises.push(this.getDiskIoStats(inputs.disk).then(r => results.diskIO = r));
        promises.push(this.getDiskUsageStats(inputs.disk).then(r => results.diskUsage = r));
     }
     if (inputs.net) promises.push(this.getNetworkStats(inputs.net).then(r => results.network = r));


    try {
      // 디버깅을 위해 더 자세한 로그 추가
      // console.log(`Getting metrics in ${this.metricsTarget} mode based on config`);
      // console.log(`Host proc prefix: ${this.hostProcPrefix}`);

      await Promise.all(promises); // 선택된 메트릭만 병렬로 수집

      // 각 결과 로깅 (선택적)
      // console.log('Collected CPU Stats:', JSON.stringify(results.cpu).substring(0, 200));
      // console.log('Collected Memory Stats:', JSON.stringify(results.memory).substring(0, 200));
      // console.log('Collected Disk IO Stats keys:', results.diskIO ? Object.keys(results.diskIO) : 'N/A');
      // console.log('Collected Network Stats keys:', results.network ? Object.keys(results.network) : 'N/A');
      // console.log('Collected Disk Usage Stats:', JSON.stringify(results.diskUsage));


      return {
        timestamp: new Date().toISOString(),
        target: this.metricsTarget, // Add target mode info
        cpu: results.cpu,
        memory: results.memory,
        diskIO: results.diskIO, // Renamed key
        network: results.network,
        diskUsage: results.diskUsage, // Add new disk usage key
      };
    } catch (error) {
      this.logger.error(`Failed to collect metrics based on config: ${error.message}`);
      console.error('Error collecting metrics:', error);
      // Return error structure consistently
      return {
        timestamp: new Date().toISOString(),
        target: this.metricsTarget,
        error: `Failed to collect metrics: ${error.message}`
      };
    }
  }

  // CPU 사용량 정보 수집 (설정 객체 인자 추가)
  private async getCpuStats(cpuConfig: InputConfig): Promise<any> {
    // cpuConfig를 사용하여 percpu, totalcpu 등의 로직 추가 가능
    // 현재 구현은 totalcpu=true 와 유사하게 동작
    try {
      if (this.metricsTarget === 'host') {
        // Host mode: read /host/proc/stat
        // console.log('Reading CPU stats from:', `${this.hostProcPrefix}/stat`);
        const statData = await fsPromises.readFile(`${this.hostProcPrefix}/stat`, 'utf8');
        // console.log('CPU stat data sample:', statData.substring(0, 200));

        const lines = statData.split('\\n');
        // console.log(`Found ${lines.length} lines in CPU stat data`);

        // 전체 CPU 라인 ('cpu ')
        const cpuLine = lines.find(line => line.startsWith('cpu '));
        if (!cpuLine) {
          console.error('Cannot find total cpu line in /host/proc/stat');
           return { error: 'Cannot find total cpu line in /host/proc/stat' }; // 에러 객체 반환
        }
        // console.log('Found Total CPU line:', cpuLine);
        const totalCpuStats = this.parseProcStatCpuLine(cpuLine);

        let perCpuStats = {};
        // percpu 설정이 true일 경우 개별 CPU 라인 파싱
        if (cpuConfig?.percpu) {
            lines.filter(line => line.startsWith('cpu') && !line.startsWith('cpu '))
                 .forEach(line => {
                     const coreId = line.split(' ')[0]; // "cpu0", "cpu1" 등
                     perCpuStats[coreId] = this.parseProcStatCpuLine(line);
                 });
        }


        return {
          // totalcpu 설정이 true 이거나 기본값일 때 totalCpuStats 포함
          ...(cpuConfig?.totalcpu !== false && { total: totalCpuStats }),
          // percpu 설정이 true 일 때 perCpuStats 포함
          ...(cpuConfig?.percpu && { per_cpu: perCpuStats }),
          source: `${this.hostProcPrefix}/stat`,
        };


      } else {
        // Container mode: try cgroup v2 first, then v1
        try {
            const cpuStat = await fsPromises.readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
            const lines = cpuStat.split('\\n');
            const stats = {};
            lines.forEach(line => {
              const [key, value] = line.split(' ').filter(Boolean);
              if (key && value) {
                 // Ensure values are numbers, handle potential non-numeric values gracefully
                 const numValue = parseInt(value, 10);
                 stats[key] = isNaN(numValue) ? value : numValue;
              }
            });
            if (Object.keys(stats).length > 0) {
              stats['source'] = '/sys/fs/cgroup/cpu.stat (v2)';
              return stats;
            }
        } catch (e) {
            this.logger.debug('Failed to read cgroup v2 cpu.stat, trying v1 or fallback.');
        }

        // Try cgroup v1
        try {
            const cpuUsage = await fsPromises.readFile('/sys/fs/cgroup/cpu/cpuacct.usage', 'utf8');
            // Cgroup v1에서는 추가적인 정보를 읽어올 수 있음 (throttling 등)
            // 필요 시 /sys/fs/cgroup/cpu/cpu.stat 등 추가 파싱
            return {
              usage_usec: parseInt(cpuUsage.trim(), 10), // Use clearer key
              source: '/sys/fs/cgroup/cpu/cpuacct.usage (v1)'
            };
        } catch (e) {
             this.logger.warn(`No cgroup CPU stats found: ${e.message}. CPU stats will be incomplete in container mode.`);
             return { error: 'Could not read container CPU stats from cgroups.', source: 'cgroup (failed)' };
        }
      }
    } catch (error) {
      console.error('CPU stats error:', error);
      this.logger.error(`Failed to get CPU stats: ${error.message}`);
      if (error.stack) {
        console.error('Stack trace:', error.stack);
      }
      return { error: `Failed to get CPU stats: ${error.message}` };
    }
  }

  // /proc/stat의 CPU 라인 파싱 헬퍼
  private parseProcStatCpuLine(line: string): any {
      const parts = line.trim().split(/\\s+/);
      const values = parts.slice(1).map(val => {
          const num = parseInt(val, 10);
          return isNaN(num) ? 0 : num;
      });

      // Jiffies 값을 포함하여 반환
      return {
          user: values[0] || 0,
          nice: values[1] || 0,
          system: values[2] || 0,
          idle: values[3] || 0,
          iowait: values[4] || 0,
          irq: values[5] || 0,
          softirq: values[6] || 0,
          steal: values[7] || 0,
          // guest: values[8] || 0, // guest/guest_nice 필요 시 추가
          // guest_nice: values[9] || 0,
          total: values.reduce((sum, val) => sum + val, 0),
          // 사용률 계산은 여기서는 하지 않음 (이전 값 필요)
          // InfluxDB로 전송 시점에 계산하거나, Telegraf 등에서 처리하도록 함
          // usage_percent: this.calculateCpuUsagePercent(values), // 이전 값 없이 계산 불가
      };
  }


  // CPU 사용률 계산 헬퍼 함수 - 이 방식은 단일 스냅샷으로는 정확하지 않음.
  // Telegraf 등은 이전 값과 비교하여 계산함. 여기서는 일단 유지.
  private calculateCpuUsagePercent(values: number[]): number {
    // user + nice + system + irq + softirq + steal을 사용 시간으로 계산
    // guest 시간도 포함해야 더 정확함 (values[8], values[9])
    const used = values[0] + values[1] + values[2] + values[5] + values[6] + values[7] + (values[8] || 0) + (values[9] || 0);
    // 전체 시간은 모든 값의 합
    const total = values.reduce((sum, val) => sum + val, 0);

    // 사용률 계산 (0-100 사이의 값) - 비율만 반환
    // 실제 사용률은 이전 측정값과의 차이를 이용해야 함
    return total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  }

  // 메모리 사용량 정보 수집 (설정 객체 인자 추가 - 현재 사용 안함)
  private async getMemoryStats(memConfig: InputConfig): Promise<any> {
     // memConfig는 현재 사용되지 않지만, 추후 확장 가능
    try {
      if (this.metricsTarget === 'host') {
        // Host mode: read /host/proc/meminfo
        // console.log('Reading memory info from:', `${this.hostProcPrefix}/meminfo`);
        const memInfoData = await fsPromises.readFile(`${this.hostProcPrefix}/meminfo`, 'utf8');

        // console.log('Memory info sample:', memInfoData.substring(0, 200));

        const lines = memInfoData.split('\\n');
        // console.log(`Found ${lines.length} lines in memory info`);

        const stats = {};
        const rawValues = {}; // 디버깅용 원시 값 저장

        lines.forEach(line => {
          // 빈 라인 건너뛰기
          if (!line.trim()) return;

          // 예: "MemTotal:       16110976 kB"
          const match = line.match(/^([a-zA-Z_()]+):\\s+(\\d+)(?:\\s+(\\w+))?/); // 키 패턴 확장 (괄호, 언더스코어 허용)
          if (match) {
            const key = match[1]; // 예: "MemTotal", "SwapCached"
            const value = parseInt(match[2], 10); // 예: 16110976
            const unit = match[3] || ''; // 예: "kB" (없을 수도 있음)

            if (!isNaN(value)) {
              rawValues[key] = { value, unit };

              // 단위에 따라 바이트로 변환 (kB 외에는 기본값 사용)
              if (unit.toLowerCase() === 'kb') {
                stats[key.toLowerCase().replace(/[^a-z0-9_]/g, '_')] = value * 1024; // 소문자, 특수문자 언더스코어로 변환
              } else {
                 stats[key.toLowerCase().replace(/[^a-z0-9_]/g, '_')] = value; // 기본 바이트 또는 단위 없는 값
              }
            }
          }
        });

        // console.log('Parsed raw memory values:', rawValues);

        if (!stats['memtotal']) {
          console.warn('memtotal not found in parsed memory info');
        }

        // 계산된 메모리 사용량 추가 (바이트 단위)
        if (stats['memtotal'] && stats['memfree'] !== undefined) {
          stats['used'] = stats['memtotal'] - stats['memfree'] - (stats['buffers'] ?? 0) - (stats['cached'] ?? 0); // used = total - free - buffers - cache
          stats['used_percent'] = stats['memtotal'] > 0 ? (stats['used'] / stats['memtotal']) * 100 : 0;
        }

        // 사용 가능한 메모리 기준 사용량 (Available이 있으면 사용)
        if (stats['memtotal'] && stats['memavailable'] !== undefined) {
          stats['available'] = stats['memavailable']; // available 필드 추가
          stats['used_actual'] = stats['memtotal'] - stats['memavailable']; // used_actual = total - available
          stats['used_percent_actual'] = stats['memtotal'] > 0 ? (stats['used_actual'] / stats['memtotal']) * 100 : 0;
        } else if (stats['memfree'] !== undefined) {
            // Available 없을 시 free + buffers + cached 근사치 사용 (덜 정확)
             stats['available'] = stats['memfree'] + (stats['buffers'] ?? 0) + (stats['cached'] ?? 0);
        }

        stats['source'] = `${this.hostProcPrefix}/meminfo`;
        return stats;


      } else {
        // Container mode: try cgroup v2 first, then v1
        const stats = { source: 'cgroup (failed)' }; // 기본 소스
        try {
            // cgroup v2: memory.current, memory.max, memory.stat
            stats['current'] = parseInt(await fsPromises.readFile('/sys/fs/cgroup/memory.current', 'utf8'), 10);
            try {
              stats['limit_bytes'] = parseInt(await fsPromises.readFile('/sys/fs/cgroup/memory.max', 'utf8'), 10);
              if (isNaN(stats['limit_bytes'])) stats['limit_bytes'] = -1; // "max" 문자열 처리
            } catch { stats['limit_bytes'] = -1; /* No limit */ } // 파일 없거나 읽기 실패

            const memoryStat = await fsPromises.readFile('/sys/fs/cgroup/memory.stat', 'utf8');
            const statLines = memoryStat.split('\\n');
            const memStats = {};
            statLines.forEach(line => {
                const [key, value] = line.split(' ');
                if (key && value) {
                    const numValue = parseInt(value, 10);
                    memStats[key] = isNaN(numValue) ? value : numValue;
                }
            });
            stats['stat'] = memStats; // memory.stat 내부 값들
            stats['source'] = '/sys/fs/cgroup/memory.* (v2)';
            return stats;

        } catch (e) {
            this.logger.debug('Failed to read cgroup v2 memory stats, trying v1.');
        }

        // cgroup v1: memory.usage_in_bytes, memory.limit_in_bytes, memory.stat
        try {
            stats['current'] = parseInt(await fsPromises.readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8'), 10);
             try {
               stats['limit_bytes'] = parseInt(await fsPromises.readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'), 10);
               if (isNaN(stats['limit_bytes']) || stats['limit_bytes'] > Number.MAX_SAFE_INTEGER) stats['limit_bytes'] = -1; // 매우 큰 값 또는 에러 처리
             } catch { stats['limit_bytes'] = -1; }

             const memoryStat = await fsPromises.readFile('/sys/fs/cgroup/memory/memory.stat', 'utf8');
             const statLines = memoryStat.split('\\n');
             const memStats = {};
             statLines.forEach(line => {
                 const [key, value] = line.split(' ');
                 if (key && value) {
                     const numValue = parseInt(value, 10);
                     memStats[key] = isNaN(numValue) ? value : numValue;
                 }
             });
             stats['stat'] = memStats;
             stats['source'] = '/sys/fs/cgroup/memory/memory.* (v1)';
             return stats;
        } catch (e) {
            this.logger.warn(`No cgroup memory stats found: ${e.message}. Memory stats will be incomplete in container mode.`);
            return { error: 'Could not read container memory stats from cgroups.', source: 'cgroup (failed)' };
        }
      }
    } catch (error) {
      console.error('Memory stats error:', error);
      this.logger.error(`Failed to get memory stats: ${error.message}`);
      if (error.stack) {
        console.error('Stack trace:', error.stack);
      }
      return { error: `Failed to get memory stats: ${error.message}` };
    }
  }

  // 디스크 I/O 통계 수집 (설정 객체 인자 추가 - 현재 사용 안함)
  private async getDiskIoStats(diskConfig: InputConfig): Promise<any> {
    // diskConfig는 현재 사용되지 않지만, 특정 장치 필터링 등에 사용 가능
    try {
      if (this.metricsTarget === 'host') {
        // Host mode: read /host/proc/diskstats
        // console.log('Reading disk I/O stats from:', `${this.hostProcPrefix}/diskstats`);
        const diskStatsData = await fsPromises.readFile(`${this.hostProcPrefix}/diskstats`, 'utf8');
        // console.log('Disk IO data sample:', diskStatsData.substring(0, 300));

        const lines = diskStatsData.split('\\n');
        const stats = {};
        // https://www.kernel.org/doc/Documentation/iostats.txt
        // Field 1 -- major number
        // Field 2 -- minor mumber
        // Field 3 -- device name
        // Field 4 -- reads completed successfully
        // Field 5 -- reads merged
        // Field 6 -- sectors read
        // Field 7 -- time spent reading (ms)
        // Field 8 -- writes completed
        // Field 9 -- writes merged
        // Field 10 -- sectors written
        // Field 11 -- time spent writing (ms)
        // Field 12 -- I/Os currently in progress
        // Field 13 -- time spent doing I/Os (ms)
        // Field 14 -- weighted time spent doing I/Os (ms)
        // ... (newer fields for discard, flush)

        lines.forEach(line => {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 14) { // 최소 필드 수 확인
            const deviceName = parts[2];
            // 파티션 제외 (숫자로 끝나는 이름) - 필요 시 조정
            if (!deviceName || /\\d+$/.test(deviceName)) return;

            stats[deviceName] = {
              reads_completed: parseInt(parts[3], 10),
              reads_merged: parseInt(parts[4], 10),
              sectors_read: parseInt(parts[5], 10),
              read_time_ms: parseInt(parts[6], 10),
              writes_completed: parseInt(parts[7], 10),
              writes_merged: parseInt(parts[8], 10),
              sectors_written: parseInt(parts[9], 10),
              write_time_ms: parseInt(parts[10], 10),
              io_in_progress: parseInt(parts[11], 10),
              io_time_ms: parseInt(parts[12], 10),
              weighted_io_time_ms: parseInt(parts[13], 10),
              source: `${this.hostProcPrefix}/diskstats`,
            };
          }
        });
        // console.log('Parsed host disk IO stats keys:', Object.keys(stats));
        return stats;

      } else {
        // Container mode: cgroup blkio stats
        const stats = {};
        const basePath = '/sys/fs/cgroup/blkio/';
        const source = 'cgroup blkio (v1)'; // cgroup v1 가정
        try {
          // 다양한 blkio 파일 읽기 시도
           const filesToRead = [
                'blkio.io_service_bytes_recursive', // Read/Write bytes
                'blkio.io_serviced_recursive',      // Read/Write operations
                // 필요 시 추가: 'blkio.throttle.io_service_bytes', 'blkio.throttle.io_serviced', etc.
            ];

            for (const file of filesToRead) {
               try {
                 const data = await fsPromises.readFile(path.join(basePath, file), 'utf8');
                 const lines = data.split('\\n');
                 lines.forEach(line => {
                      if (!line.trim()) return;
                      const parts = line.split(' ');
                      if (parts.length < 3) return; // <major>:<minor> <operation> <value>

                      const device = parts[0]; // Major:Minor 형식 유지
                      const operation = parts[1].toLowerCase(); // read, write 등
                      const value = parseInt(parts[2], 10);

                      if (!stats[device]) stats[device] = { source };

                      // 파일 이름과 operation을 기반으로 필드 이름 결정
                      if (file.includes('io_service_bytes') && operation === 'read') stats[device]['io_service_bytes_recursive_read'] = value;
                      else if (file.includes('io_service_bytes') && operation === 'write') stats[device]['io_service_bytes_recursive_write'] = value;
                      else if (file.includes('io_serviced') && operation === 'read') stats[device]['io_serviced_recursive_read'] = value;
                      else if (file.includes('io_serviced') && operation === 'write') stats[device]['io_serviced_recursive_write'] = value;
                      // 필요한 다른 blkio 메트릭 추가
                 });
               } catch (readError) {
                 // 개별 파일 읽기 실패는 debug 레벨로 로깅
                 this.logger.debug(`Failed to read cgroup blkio file ${file}: ${readError.message}`);
               }
            }

             if (Object.keys(stats).length === 0) {
                 this.logger.warn(`No cgroup blkio stats found in ${basePath}. Disk IO stats will be incomplete in container mode.`);
                 return { error: 'Could not read container disk IO stats from cgroups.', source: 'cgroup (failed)' };
             }
             // console.log('Parsed container disk IO stats keys:', Object.keys(stats));
             return stats;

        } catch (error) {
          console.error('Container disk I/O stats error:', error);
          this.logger.error(`Failed to get container disk I/O stats: ${error.message}`);
          return { error: `Failed to get container disk I/O stats: ${error.message}` };
        }
      }
    } catch (error) {
      console.error('Disk I/O stats error:', error);
      this.logger.error(`Failed to get disk I/O stats: ${error.message}`);
      if (error.stack) {
        console.error('Stack trace:', error.stack);
      }
      return { error: `Failed to get disk I/O stats: ${error.message}` };
    }
  }

  // 디스크 사용량 통계 수집 (설정 객체 인자 추가)
  private async getDiskUsageStats(diskConfig: InputConfig): Promise<any> {
     const ignoreFs = diskConfig?.ignore_fs || []; // 설정에서 무시할 파일 시스템 목록 가져오기
     const stats = {};

     try {
        // 호스트 모드: 루트 '/' 또는 특정 경로의 디스크 사용량 확인
        // 컨테이너 모드: 컨테이너 내부의 '/' 경로 확인 (주로 overlayfs 등)
        // check-disk-space는 지정된 경로가 속한 파일 시스템의 사용량을 반환
        const basePath = this.metricsTarget === 'host' ? '/' : '/'; // 호스트 모드도 일단 / 기준. 필요시 설정에서 경로 받아오도록 수정
        this.logger.debug(`Checking disk space for path: ${basePath}`);

        // 마운트된 파일 시스템 정보 읽기 (/proc/mounts 또는 /etc/mtab)
        // 호스트 모드에서는 /host/proc/mounts 읽기 시도
        const mountsPath = this.metricsTarget === 'host' ? `${this.hostProcPrefix}/mounts` : '/proc/mounts';
        let mountPoints = ['/']; // 기본값으로 루트 포함

        try {
           const mountsData = await fsPromises.readFile(mountsPath, 'utf8');
           mountPoints = mountsData.split('\\n')
               .map(line => {
                   const parts = line.split(' ');
                   if (parts.length < 3) return null;
                   const mountPoint = parts[1];
                   const fsType = parts[2];
                   // ignoreFs 목록에 포함되거나, 특수 파일 시스템(proc, sys, devpts 등) 제외
                   if (ignoreFs.includes(fsType) || ['proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'securityfs'].includes(fsType)) {
                       return null;
                   }
                   return mountPoint;
               })
               .filter(mp => mp !== null) // null 제거
               .filter((value, index, self) => self.indexOf(value) === index); // 중복 제거
           // 루트가 목록에 없으면 추가
           if (!mountPoints.includes('/')) {
              mountPoints.push('/');
           }
           this.logger.debug(`Found mount points to check: ${mountPoints.join(', ')}`);

        } catch (mountError) {
            this.logger.warn(`Failed to read mount points from ${mountsPath}: ${mountError.message}. Checking only '/'.`);
            mountPoints = ['/']; // 마운트 정보 읽기 실패 시 루트만 확인
        }


        // 각 유효한 마운트 포인트에 대해 디스크 사용량 확인
        for (const mountPoint of mountPoints) {
            try {
                const diskSpace = await checkDiskSpace(mountPoint);
                // diskSpace 객체: { diskPath: '/', free: Bytes, size: Bytes }
                if (diskSpace && diskSpace.size > 0) { // 유효한 결과인지 확인
                    const used = diskSpace.size - diskSpace.free;
                    stats[mountPoint] = {
                        size: diskSpace.size,
                        free: diskSpace.free,
                        used: used,
                        usagePercent: (used / diskSpace.size) * 100,
                        source: `checkDiskSpace('${mountPoint}')`
                    };
                } else {
                     this.logger.warn(`Invalid disk space data for mount point: ${mountPoint}`);
                     stats[mountPoint] = { error: 'Invalid disk space data', source: `checkDiskSpace('${mountPoint}')` };
                }
            } catch (error) {
                this.logger.warn(`Failed to get disk usage for mount point ${mountPoint}: ${error.message}`);
                 stats[mountPoint] = { error: `Failed to get disk usage: ${error.message}`, source: `checkDiskSpace('${mountPoint}')` };
            }
        }

        // console.log('Parsed disk usage stats:', stats);
        return stats;

     } catch (error) {
        console.error('Disk usage stats error:', error);
        this.logger.error(`Failed to get disk usage stats: ${error.message}`);
        return { error: `Failed to get disk usage stats: ${error.message}` };
     }
  }


  // 네트워크 통계 수집 (설정 객체 인자 추가)
  private async getNetworkStats(netConfig: InputConfig): Promise<any> {
      const interfacesToInclude = netConfig?.interfaces; // 설정에서 포함할 인터페이스 목록
      try {
          const netDevPath = this.metricsTarget === 'host' ? `${this.hostProcPrefix}/net/dev` : '/proc/net/dev';
          // console.log('Reading network stats from:', netDevPath);
          const netData = await fsPromises.readFile(netDevPath, 'utf8');
          // console.log('Net dev data sample:', netData.substring(0, 300));

          const lines = netData.split('\\n');
          const stats = {};
          // Header lines skipped (first 2 lines)
          for (let i = 2; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;

              const parts = line.split(/:\s+|\s+/); // 콜론 또는 공백으로 분리
              const interfaceName = parts[0];

              // 설정된 인터페이스 목록이 있고, 현재 인터페이스가 목록에 없으면 건너뜀
              if (interfacesToInclude && interfacesToInclude.length > 0 && !interfacesToInclude.includes(interfaceName)) {
                  continue;
              }

              // lo 인터페이스 제외 (일반적으로 불필요) - 필요시 설정으로 제어
              if (interfaceName === 'lo') continue;


              if (parts.length >= 17) { // 기본 IPv4 카운터 수 확인
                  stats[interfaceName] = {
                      rx_bytes: parseInt(parts[1], 10),
                      rx_packets: parseInt(parts[2], 10),
                      rx_errors: parseInt(parts[3], 10),
                      rx_dropped: parseInt(parts[4], 10),
                      // rx_fifo: parseInt(parts[5], 10),
                      // rx_frame: parseInt(parts[6], 10),
                      // rx_compressed: parseInt(parts[7], 10),
                      // rx_multicast: parseInt(parts[8], 10),
                      tx_bytes: parseInt(parts[9], 10),
                      tx_packets: parseInt(parts[10], 10),
                      tx_errors: parseInt(parts[11], 10),
                      tx_dropped: parseInt(parts[12], 10),
                      // tx_fifo: parseInt(parts[13], 10),
                      // tx_collisions: parseInt(parts[14], 10),
                      // tx_carrier: parseInt(parts[15], 10),
                      // tx_compressed: parseInt(parts[16], 10),
                      source: netDevPath,
                  };
              }
          }
          // console.log('Parsed network stats keys:', Object.keys(stats));
          return stats;
      } catch (error) {
          console.error('Network stats error:', error);
          this.logger.error(`Failed to get network stats: ${error.message}`);
          if (error.stack) {
              console.error('Stack trace:', error.stack);
          }
          return { error: `Failed to get network stats: ${error.message}` };
      }
  }

  // 최신 원시 메트릭 데이터를 반환하는 공개 메소드 추가
  public getLatestRawMetrics(): any | null {
    return this.latestRawMetrics;
  }

} // End of MetricsService class
