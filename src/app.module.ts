import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MetricsModule
  ],
})
export class AppModule {} 