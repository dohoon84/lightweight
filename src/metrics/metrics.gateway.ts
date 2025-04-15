import { 
  WebSocketGateway, 
  WebSocketServer, 
  OnGatewayConnection, 
  OnGatewayDisconnect 
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { MetricsService } from './metrics.service';

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  path: '/socket.io',
})
export class MetricsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(MetricsGateway.name);
  private clients: Set<Socket> = new Set();
  private metricsInterval: NodeJS.Timeout | null = null;
  private readonly UPDATE_INTERVAL = 1000; // 1초마다 메트릭 데이터 전송

  constructor(private readonly metricsService: MetricsService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.clients.add(client);

    // 첫 클라이언트 연결 시 메트릭 수집 시작
    if (this.clients.size === 1) {
      this.startMetricsCollection();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.clients.delete(client);

    // 모든 클라이언트가 연결 해제되면 메트릭 수집 중지
    if (this.clients.size === 0) {
      this.stopMetricsCollection();
    }
  }

  private startMetricsCollection() {
    this.logger.log('Starting metrics collection');
    
    // 주기적으로 메트릭 수집 및 전송
    this.metricsInterval = setInterval(async () => {
      try {
        const metrics = await this.metricsService.getMetrics();
        this.server.emit('metrics', metrics);
      } catch (error) {
        this.logger.error(`Error collecting or sending metrics: ${error.message}`);
      }
    }, this.UPDATE_INTERVAL);
  }

  private stopMetricsCollection() {
    this.logger.log('Stopping metrics collection');
    
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
  }
} 