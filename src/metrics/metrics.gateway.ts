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
  private dashboardUpdateInterval: NodeJS.Timeout | null = null;
  private readonly DASHBOARD_UPDATE_INTERVAL = 1000;

  constructor(private readonly metricsService: MetricsService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.clients.add(client);

    if (this.clients.size === 1 && !this.dashboardUpdateInterval) {
      this.startDashboardUpdates();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.clients.delete(client);

    if (this.clients.size === 0 && this.dashboardUpdateInterval) {
      this.stopDashboardUpdates();
    }
  }

  private startDashboardUpdates() {
    this.logger.log('Starting dashboard updates');
    this.dashboardUpdateInterval = setInterval(async () => {
      try {
        const latestMetrics = this.metricsService.getLatestRawMetrics();
        if (latestMetrics) {
          this.server.emit('metrics', latestMetrics);
        } else {
          this.logger.debug('No metrics data available yet to send to dashboard.');
        }
      } catch (error) {
        this.logger.error(`Error sending metrics to dashboard: ${error.message}`);
      }
    }, this.DASHBOARD_UPDATE_INTERVAL);
  }

  private stopDashboardUpdates() {
    this.logger.log('Stopping dashboard updates');
    if (this.dashboardUpdateInterval) {
      clearInterval(this.dashboardUpdateInterval);
      this.dashboardUpdateInterval = null;
    }
  }
} 