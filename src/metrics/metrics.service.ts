import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
// Remove exec import if no longer needed after refactoring
// import { exec } from 'child_process'; 
// import { promisify } from 'util';

// const execAsync = promisify(exec);

type MetricsTarget = 'container' | 'host';

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly metricsTarget: MetricsTarget;
  private readonly hostProcPrefix = '/host/proc'; // Assuming mount point for host /proc

  constructor() {
    // Read the target mode from environment variable, default to 'container'
    this.metricsTarget = process.env.METRICS_TARGET === 'host' ? 'host' : 'container';
    this.logger.log(`Metrics target set to: ${this.metricsTarget}`);
    if (this.metricsTarget === 'host') {
      this.logger.warn(
        `Running in 'host' mode. Ensure the host's /proc filesystem is mounted read-only at ${this.hostProcPrefix} in the container. (e.g., -v /proc:${this.hostProcPrefix}:ro)`,
      );
    }
  }

  // Renamed from getContainerMetrics
  async getMetrics(): Promise<any> {
    try {
      // 디버깅을 위해 더 자세한 로그 추가
      console.log(`Getting metrics in ${this.metricsTarget} mode`);
      console.log(`Host proc prefix: ${this.hostProcPrefix}`);
      
      const [cpuStats, memoryStats, diskStats, networkStats] = await Promise.all([
        this.getCpuStats(),
        this.getMemoryStats(),
        this.getDiskStats(),
        this.getNetworkStats(),
      ]);
      
      // 각 결과 로깅
      console.log('CPU Stats:', JSON.stringify(cpuStats).substring(0, 200));
      console.log('Memory Stats:', JSON.stringify(memoryStats).substring(0, 200));
      console.log('Disk Stats keys:', Object.keys(diskStats));
      console.log('Network Stats keys:', Object.keys(networkStats));

      return {
        timestamp: new Date().toISOString(),
        target: this.metricsTarget, // Add target mode info
        cpu: cpuStats,
        memory: memoryStats,
        disk: diskStats,
        network: networkStats,
      };
    } catch (error) {
      this.logger.error(`Failed to collect metrics: ${error.message}`);
      console.error('Error collecting metrics:', error);
      // Return error structure consistently
      return { 
        timestamp: new Date().toISOString(),
        target: this.metricsTarget,
        error: `Failed to collect metrics: ${error.message}` 
      };
    }
  }

  // CPU 사용량 정보 수집
  private async getCpuStats(): Promise<any> {
    try {
      if (this.metricsTarget === 'host') {
        // Host mode: read /host/proc/stat
        console.log('Reading CPU stats from:', `${this.hostProcPrefix}/stat`);
        const statData = await fs.readFile(`${this.hostProcPrefix}/stat`, 'utf8');
        
        // 디버깅: 파일 내용 일부 출력
        console.log('CPU stat data sample:', statData.substring(0, 200));
        
        // 줄 단위로 분리
        const lines = statData.split('\n');
        console.log(`Found ${lines.length} lines in CPU stat data`);
        
        // cpu 라인 찾기 (첫 번째 라인이어야 함)
        const cpuLine = lines.find(line => line.startsWith('cpu '));
        if (!cpuLine) {
          console.error('Cannot find cpu line in /host/proc/stat');
          throw new Error('Cannot find cpu line in /host/proc/stat');
        }
        
        console.log('Found CPU line:', cpuLine);
        
        // 공백으로 분리하여 값 추출
        const parts = cpuLine.trim().split(/\s+/);
        console.log('CPU line parts:', parts);
        
        // 'cpu' 레이블을 제외하고 숫자 값만 사용
        const values = parts.slice(1).map(val => {
          const num = parseInt(val, 10);
          return isNaN(num) ? 0 : num;
        });
        
        console.log('Parsed CPU values:', values);
        
        // CPU 사용량 계산 (전체 데이터 반환)
        return {
          user: values[0] || 0,
          nice: values[1] || 0,
          system: values[2] || 0,
          idle: values[3] || 0,
          iowait: values[4] || 0,
          irq: values[5] || 0,
          softirq: values[6] || 0,
          steal: values[7] || 0,
          total: values.reduce((sum, val) => sum + val, 0),
          // 계산된 CPU 사용률 추가 (백분율)
          usage_percent: this.calculateCpuUsagePercent(values),
          source: `${this.hostProcPrefix}/stat`,
        };
      } else {
        // Container mode: try cgroup v2 first, then v1
        try {
            const cpuStat = await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
            const lines = cpuStat.split('\n');
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
            const cpuUsage = await fs.readFile('/sys/fs/cgroup/cpu/cpuacct.usage', 'utf8');
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

  // CPU 사용률 계산 헬퍼 함수
  private calculateCpuUsagePercent(values: number[]): number {
    // user + nice + system + irq + softirq + steal을 사용 시간으로 계산
    const used = values[0] + values[1] + values[2] + values[5] + values[6] + values[7];
    // 전체 시간은 모든 값의 합
    const total = values.reduce((sum, val) => sum + val, 0);
    
    // 사용률 계산 (0-100 사이의 값)
    return total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  }

  // 메모리 사용량 정보 수집
  private async getMemoryStats(): Promise<any> {
    try {
      if (this.metricsTarget === 'host') {
        // Host mode: read /host/proc/meminfo
        console.log('Reading memory info from:', `${this.hostProcPrefix}/meminfo`);
        const memInfoData = await fs.readFile(`${this.hostProcPrefix}/meminfo`, 'utf8');
        
        // 디버깅: 파일 내용 일부 출력
        console.log('Memory info sample:', memInfoData.substring(0, 200));
        
        // 줄 단위로 분리
        const lines = memInfoData.split('\n');
        console.log(`Found ${lines.length} lines in memory info`);
        
        const stats = {};
        const rawValues = {}; // 디버깅용 원시 값 저장
        
        lines.forEach(line => {
          // 빈 라인 건너뛰기
          if (!line.trim()) return;
          
          // 예: "MemTotal:       16110976 kB"
          const match = line.match(/^(\w+):\s+(\d+)(?:\s+(\w+))?/);
          if (match) {
            const key = match[1]; // 예: "MemTotal"
            const value = parseInt(match[2], 10); // 예: 16110976
            const unit = match[3] || ''; // 예: "kB" (없을 수도 있음)
            
            if (!isNaN(value)) {
              rawValues[key] = { value, unit };
              
              // 단위에 따라 바이트로 변환
              if (unit.toLowerCase() === 'kb') {
                stats[key] = value * 1024;
              } else if (unit.toLowerCase() === 'mb') {
                stats[key] = value * 1024 * 1024;
              } else {
                stats[key] = value;
              }
            }
          }
        });
        
        // 디버깅: 파싱된 원시 값 
        console.log('Parsed raw memory values:', rawValues);
        
        // 주요 메모리 정보가 있는지 확인
        if (!stats['MemTotal']) {
          console.warn('MemTotal not found in parsed memory info');
        }
        
        // 계산된 메모리 사용량 추가
        if (stats['MemTotal'] && stats['MemFree']) {
          stats['MemUsed'] = stats['MemTotal'] - stats['MemFree'];
          stats['MemUsedPercent'] = (stats['MemUsed'] / stats['MemTotal']) * 100;
        }
        
        if (stats['MemTotal'] && stats['MemAvailable']) {
          stats['MemUsedActual'] = stats['MemTotal'] - stats['MemAvailable'];
          stats['MemUsedPercentActual'] = (stats['MemUsedActual'] / stats['MemTotal']) * 100;
        }
        
        stats['source'] = `${this.hostProcPrefix}/meminfo`;
        return stats;
      } else {
         // Container mode: try cgroup v2 first, then v1
         try {
             const memoryStat = await fs.readFile('/sys/fs/cgroup/memory.stat', 'utf8');
             const lines = memoryStat.split('\n');
             const stats = {};
             lines.forEach(line => {
                 const [key, value] = line.split(' ').filter(Boolean);
                 if (key && value) {
                    const numValue = parseInt(value, 10);
                    stats[key] = isNaN(numValue) ? value : numValue;
                 }
             });
             if (Object.keys(stats).length > 0){
                stats['source'] = '/sys/fs/cgroup/memory.stat (v2)';
                return stats;
             }
         } catch (e) {
             this.logger.debug('Failed to read cgroup v2 memory.stat, trying v1.');
         }

         // Try cgroup v1
         try {
             const memoryUsage = await fs.readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8');
             const memoryLimit = await fs.readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8');
             // Handle potential "max" value for limit
             const limit = memoryLimit.trim().toLowerCase() === 'max' ? Infinity : parseInt(memoryLimit.trim(), 10);

             return {
                 usage_bytes: parseInt(memoryUsage.trim(), 10),
                 limit_bytes: limit,
                 source: '/sys/fs/cgroup/memory/ (v1)'
             };
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

  // 디스크 I/O 정보 수집
  private async getDiskStats(): Promise<any> {
    try {
      if (this.metricsTarget === 'host') {
        // Host mode: read /host/proc/diskstats
        console.log('Reading disk stats from:', `${this.hostProcPrefix}/diskstats`);
        const diskStatData = await fs.readFile(`${this.hostProcPrefix}/diskstats`, 'utf8');
        
        // 디버깅: 파일 내용 일부 출력
        console.log('Disk stats sample:', diskStatData.substring(0, 200));
        
        // 줄 단위로 분리
        const lines = diskStatData.trim().split('\n');
        console.log(`Found ${lines.length} lines in disk stats`);
        
        const stats = {};
        let deviceCount = 0;
        
        lines.forEach(line => {
          // 빈 라인 건너뛰기
          if (!line.trim()) return;
          
          const parts = line.trim().split(/\s+/);
          // Format: major minor device reads reads_merged sectors read_ms writes writes_merged sectors write_ms io_in_progress io_ms weighted_io_ms
          if (parts.length >= 14) { 
            const device = parts[2];
            
            // 루프 장치, RAM 장치 등 필터링 (선택적)
            // if (device.startsWith('loop') || device.startsWith('ram')) return;
            
            deviceCount++;
            stats[device] = {
              reads_completed: parseInt(parts[3], 10) || 0,
              sectors_read: parseInt(parts[5], 10) || 0,
              time_reading_ms: parseInt(parts[6], 10) || 0,
              writes_completed: parseInt(parts[7], 10) || 0,
              sectors_written: parseInt(parts[9], 10) || 0,
              time_writing_ms: parseInt(parts[10], 10) || 0,
              io_in_progress: parseInt(parts[11], 10) || 0,
              time_io_ms: parseInt(parts[12], 10) || 0,
              weighted_time_io_ms: parseInt(parts[13], 10) || 0,
            };
            
            // 섹터 크기는 일반적으로 512바이트이므로 바이트 단위로 변환
            stats[device].bytes_read = stats[device].sectors_read * 512;
            stats[device].bytes_written = stats[device].sectors_written * 512;
          }
        });
        
        console.log(`Parsed stats for ${deviceCount} disk devices`);
        
        // 실제 물리 디스크 목록 (예: xvda, sda 등)
        const physicalDisks = Object.keys(stats).filter(dev => !dev.match(/\d+$/) || dev.match(/^(xvd|sd|hd|vd|nvme)/));
        
        if (physicalDisks.length > 0) {
          console.log('Found physical disks:', physicalDisks);
          
          // 주요 디스크 정보를 상위 레벨에 추가
          const mainDisk = physicalDisks[0];
          stats['main_disk'] = mainDisk;
          stats['total_reads'] = stats[mainDisk].reads_completed;
          stats['total_writes'] = stats[mainDisk].writes_completed;
          stats['total_bytes_read'] = stats[mainDisk].bytes_read;
          stats['total_bytes_written'] = stats[mainDisk].bytes_written;
        } else {
          console.warn('No physical disks found in parsed data');
        }
        
        stats['source'] = `${this.hostProcPrefix}/diskstats`;
        return stats;
      } else {
        // Container mode: try cgroup v2 first, then v1
        try {
            const ioStat = await fs.readFile('/sys/fs/cgroup/io.stat', 'utf8');
            const lines = ioStat.split('\n');
            const stats = {};
            lines.forEach(line => {
                if (line.trim()) {
                   // Format: "maj:min rbytes=N wbytes=N rios=N wios=N dbytes=N dios=N" or per-device lines
                   // This parsing might need adjustment based on actual io.stat format variations
                   const parts = line.match(/^(\d+:\d+)\s+(.*)$/);
                   if (parts && parts.length === 3) {
                      const deviceId = parts[1];
                      stats[deviceId] = {};
                      parts[2].split(' ').forEach(metric => {
                         const [key, value] = metric.split('=');
                         if (key && value) {
                            const numValue = parseInt(value, 10);
                            stats[deviceId][key] = isNaN(numValue) ? value : numValue;
                         }
                      });
                   } else {
                      // Handle potential aggregated line format if necessary
                   }
                }
            });
            if (Object.keys(stats).length > 0) {
                stats['source'] = '/sys/fs/cgroup/io.stat (v2)';
                return stats;
            }
        } catch (e) {
            this.logger.debug('Failed to read cgroup v2 io.stat, trying v1.');
        }

        // Try cgroup v1 blkio
        try {
            // Reading specific files like blkio.throttle.io_service_bytes might be more reliable than io.stat
            const blkioRead = await fs.readFile('/sys/fs/cgroup/blkio/blkio.throttle.io_service_bytes', 'utf8').catch(() => '');
            const blkioWrite = await fs.readFile('/sys/fs/cgroup/blkio/blkio.throttle.io_serviced', 'utf8').catch(() => ''); // For op counts

            const stats = {};
            const parseBlkio = (data: string, valueKey: string) => {
              data.split('\n').forEach(line => {
                const parts = line.trim().split(' ');
                if (parts.length === 3 && parts[1].toLowerCase() !== 'total') {
                  const device = parts[0]; // maj:min format
                  const op = parts[1].toLowerCase(); // read/write/sync/async
                  const value = parseInt(parts[2], 10);
                  if (!stats[device]) stats[device] = {};
                  if (!stats[device][op]) stats[device][op] = {};
                  stats[device][op][valueKey] = value;
                }
              });
            };
            
            parseBlkio(blkioRead, 'bytes');
            parseBlkio(blkioWrite, 'ops');

            if (Object.keys(stats).length > 0) {
                stats['source'] = '/sys/fs/cgroup/blkio/ (v1)';
                return stats;
            } else {
                throw new Error('No v1 blkio data found');
            }
        } catch(e) {
            this.logger.warn(`No cgroup disk stats found: ${e.message}. Disk stats will be incomplete in container mode.`);
            return { error: 'Could not read container disk stats from cgroups.', source: 'cgroup (failed)' };
        }
      }
    } catch (error) {
      console.error('Disk stats error:', error);
      this.logger.error(`Failed to get disk stats: ${error.message}`);
      if (error.stack) {
        console.error('Stack trace:', error.stack);
      }
      return { error: `Failed to get disk stats: ${error.message}` };
    }
  }

  // 네트워크 통계 정보 수집
  private async getNetworkStats(): Promise<any> {
    // Network stats are typically not in cgroups, always read from /proc/net/dev
    // Adjust path based on host mode
    const networkPath = this.metricsTarget === 'host' ? `${this.hostProcPrefix}/net/dev` : '/proc/net/dev';
    try {
      console.log('Reading network stats from:', networkPath);
      const netDevData = await fs.readFile(networkPath, 'utf8');
      
      // 디버깅: 파일 내용 출력
      console.log('Network stats data:', netDevData);
      
      // 줄 단위로 분리
      const lines = netDevData.trim().split('\n');
      console.log(`Found ${lines.length} lines in network stats`);
      
      // 헤더 라인이 있는지 확인
      const hasHeaders = lines.length > 0 && lines[0].includes('|');
      
      // 데이터 라인만 선택
      const dataLines = hasHeaders ? lines.slice(2) : lines;
      console.log(`Processing ${dataLines.length} network data lines`);
      
      const stats = {};
      dataLines.forEach(line => {
        // 빈 라인 건너뛰기
        if (!line.trim()) return;
        
        console.log('Processing network line:', line);
        
        // 인터페이스 이름과 데이터 부분 분리
        const parts = line.trim().split(':');
        if (parts.length < 2) {
          console.log(`Skipping invalid line: ${line}`);
          return;
        }
        
        const interfaceName = parts[0].trim();
        // 콜론 뒤의 모든 텍스트를 데이터 부분으로 처리
        const dataStr = parts.slice(1).join(':').trim();
        
        // 값을 공백으로 분리
        const values = dataStr.split(/\s+/).map(val => {
          const num = parseInt(val, 10);
          return isNaN(num) ? 0 : num;
        });
        
        // 값 개수 확인
        if (values.length < 16) {
          console.log(`Interface ${interfaceName} has insufficient data: ${values.length} fields, expected at least 16`);
          console.log('Values:', values);
          return;
        }
        
        // lo 인터페이스는 건너뛸 수 있음 (선택적)
        // if (interfaceName === 'lo') return;
        
        stats[interfaceName] = {
          rx_bytes: values[0],
          rx_packets: values[1],
          rx_errs: values[2],
          rx_drop: values[3],
          tx_bytes: values[8],
          tx_packets: values[9],
          tx_errs: values[10],
          tx_drop: values[11],
          // 추가 정보 (필요시)
          rx_kb: Math.round(values[0] / 1024),
          tx_kb: Math.round(values[8] / 1024),
          rx_mb: Math.round(values[0] / (1024 * 1024) * 100) / 100,
          tx_mb: Math.round(values[8] / (1024 * 1024) * 100) / 100,
        };
      });
      
      // 기본 인터페이스 찾기 (lo가 아닌 첫 번째 인터페이스, 일반적으로 eth0)
      const interfaces = Object.keys(stats).filter(iface => iface !== 'lo');
      if (interfaces.length > 0) {
        const mainInterface = interfaces[0];
        stats['main_interface'] = mainInterface;
        stats['total_rx_bytes'] = stats[mainInterface].rx_bytes;
        stats['total_tx_bytes'] = stats[mainInterface].tx_bytes;
        stats['total_rx_mb'] = stats[mainInterface].rx_mb;
        stats['total_tx_mb'] = stats[mainInterface].tx_mb;
      }
      
      console.log('Parsed network interfaces:', Object.keys(stats));
      stats['source'] = networkPath;
      return stats;
    } catch (error) {
      console.error('Network stats error:', error);
      // 특수 에러 처리
      if (this.metricsTarget === 'host' && error.code === 'ENOENT') {
        console.error(`${networkPath} not found. Is /proc mounted correctly at ${this.hostProcPrefix}?`);
        return { 
          error: `${networkPath} not found. Is host /proc mounted correctly?`, 
          source: networkPath + ' (failed)'
        };
      }
      this.logger.error(`Failed to get network stats from ${networkPath}: ${error.message}`);
      if (error.stack) {
        console.error('Stack trace:', error.stack);
      }
      return { 
        error: `Failed to get network stats: ${error.message}`, 
        source: networkPath + ' (failed)' 
      };
    }
  }
} 