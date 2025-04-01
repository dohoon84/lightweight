import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  // 컨테이너 메트릭 정보 가져오기
  async getContainerMetrics(): Promise<any> {
    try {
      // CPU 사용량 정보
      const cpuStats = await this.getCpuStats();
      
      // 메모리 사용량 정보
      const memoryStats = await this.getMemoryStats();
      
      // 디스크 I/O 정보
      const diskStats = await this.getDiskStats();
      
      // 네트워크 통계 정보
      const networkStats = await this.getNetworkStats();

      return {
        timestamp: new Date().toISOString(),
        cpu: cpuStats,
        memory: memoryStats,
        disk: diskStats,
        network: networkStats,
      };
    } catch (error) {
      this.logger.error(`Failed to collect metrics: ${error.message}`);
      return { error: error.message };
    }
  }

  // CPU 사용량 정보 수집
  private async getCpuStats(): Promise<any> {
    try {
      // cgroup v2를 사용하는 경우
      const cpuStat = await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8').catch(() => null);
      
      if (cpuStat) {
        const lines = cpuStat.split('\n');
        const stats = {};
        
        lines.forEach(line => {
          const [key, value] = line.split(' ').filter(Boolean);
          if (key && value) {
            stats[key] = parseInt(value, 10);
          }
        });
        
        return stats;
      }
      
      // cgroup v1을 사용하는 경우 대안
      const cpuUsage = await fs.readFile('/sys/fs/cgroup/cpu/cpuacct.usage', 'utf8').catch(() => null);
      
      if (cpuUsage) {
        return { usage: parseInt(cpuUsage.trim(), 10) };
      }
      
      // 컨테이너가 아닌 환경에서는 기본 시스템 통계 사용
      const { stdout } = await execAsync('cat /proc/stat | grep "^cpu "');
      const values = stdout.trim().split(/\s+/).slice(1);
      
      return {
        user: parseInt(values[0], 10),
        nice: parseInt(values[1], 10),
        system: parseInt(values[2], 10),
        idle: parseInt(values[3], 10),
        iowait: parseInt(values[4], 10),
      };
    } catch (error) {
      this.logger.error(`Failed to get CPU stats: ${error.message}`);
      return { error: error.message };
    }
  }

  // 메모리 사용량 정보 수집
  private async getMemoryStats(): Promise<any> {
    try {
      // cgroup v2를 사용하는 경우
      const memoryStat = await fs.readFile('/sys/fs/cgroup/memory.stat', 'utf8').catch(() => null);
      
      if (memoryStat) {
        const lines = memoryStat.split('\n');
        const stats = {};
        
        lines.forEach(line => {
          const [key, value] = line.split(' ').filter(Boolean);
          if (key && value) {
            stats[key] = parseInt(value, 10);
          }
        });
        
        return stats;
      }
      
      // cgroup v1을 사용하는 경우 대안
      const memoryUsage = await fs.readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').catch(() => null);
      const memoryLimit = await fs.readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').catch(() => null);
      
      if (memoryUsage && memoryLimit) {
        return {
          usage: parseInt(memoryUsage.trim(), 10),
          limit: parseInt(memoryLimit.trim(), 10),
        };
      }
      
      // 컨테이너가 아닌 환경에서는 기본 시스템 통계 사용
      const { stdout } = await execAsync('free -b');
      const lines = stdout.trim().split('\n');
      const memInfo = lines[1].split(/\s+/).map(val => parseInt(val, 10));
      
      return {
        total: memInfo[1],
        used: memInfo[2],
        free: memInfo[3],
        shared: memInfo[4],
        buffers: memInfo[5],
        cache: memInfo[6],
      };
    } catch (error) {
      this.logger.error(`Failed to get memory stats: ${error.message}`);
      return { error: error.message };
    }
  }

  // 디스크 I/O 정보 수집
  private async getDiskStats(): Promise<any> {
    try {
      // cgroup v2를 사용하는 경우
      const ioStat = await fs.readFile('/sys/fs/cgroup/io.stat', 'utf8').catch(() => null);
      
      if (ioStat) {
        const lines = ioStat.split('\n');
        const stats = {};
        
        lines.forEach(line => {
          if (line.trim()) {
            const [device, metrics] = line.split(':');
            if (device && metrics) {
              stats[device] = {};
              metrics.split(' ').forEach(metric => {
                const [key, value] = metric.split('=');
                if (key && value) {
                  stats[device][key] = parseInt(value, 10);
                }
              });
            }
          }
        });
        
        return stats;
      }
      
      // cgroup v1을 사용하는 경우 대안
      const blkioStats = await fs.readFile('/sys/fs/cgroup/blkio/blkio.throttle.io_service_bytes', 'utf8').catch(() => null);
      
      if (blkioStats) {
        const lines = blkioStats.split('\n');
        const stats = {};
        
        lines.forEach(line => {
          const parts = line.trim().split(' ');
          if (parts.length === 3) {
            const [device, op, bytes] = parts;
            if (!stats[device]) {
              stats[device] = {};
            }
            stats[device][op.toLowerCase()] = parseInt(bytes, 10);
          }
        });
        
        return stats;
      }
      
      // 컨테이너가 아닌 환경에서는 기본 시스템 통계 사용
      const { stdout } = await execAsync('cat /proc/diskstats');
      const lines = stdout.trim().split('\n');
      const stats = {};
      
      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 14) {
          const device = parts[2];
          stats[device] = {
            read_completed: parseInt(parts[3], 10),
            read_merged: parseInt(parts[4], 10),
            read_sectors: parseInt(parts[5], 10),
            read_time_ms: parseInt(parts[6], 10),
            write_completed: parseInt(parts[7], 10),
            write_merged: parseInt(parts[8], 10),
            write_sectors: parseInt(parts[9], 10),
            write_time_ms: parseInt(parts[10], 10),
          };
        }
      });
      
      return stats;
    } catch (error) {
      this.logger.error(`Failed to get disk stats: ${error.message}`);
      return { error: error.message };
    }
  }

  // 네트워크 통계 정보 수집
  private async getNetworkStats(): Promise<any> {
    try {
      // 네트워크 통계는 cgroup에서 직접 제공하지 않아 /proc에서 가져옴
      const { stdout } = await execAsync('cat /proc/net/dev');
      const lines = stdout.trim().split('\n').slice(2); // 헤더 제거
      const stats = {};
      
      lines.forEach(line => {
        const [interfacePart, ...dataParts] = line.trim().split(':');
        const interfaceName = interfacePart.trim();
        const data = dataParts.join(':').trim().split(/\s+/).map(val => parseInt(val, 10));
        
        stats[interfaceName] = {
          rx_bytes: data[0],
          rx_packets: data[1],
          rx_errs: data[2],
          rx_drop: data[3],
          tx_bytes: data[8],
          tx_packets: data[9],
          tx_errs: data[10],
          tx_drop: data[11],
        };
      });
      
      return stats;
    } catch (error) {
      this.logger.error(`Failed to get network stats: ${error.message}`);
      return { error: error.message };
    }
  }
} 