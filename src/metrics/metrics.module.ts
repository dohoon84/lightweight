import { Module } from '@nestjs/common';
import { MetricsGateway } from './metrics.gateway';
import { MetricsService } from './metrics.service';

@Module({
  providers: [MetricsGateway, MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {} 