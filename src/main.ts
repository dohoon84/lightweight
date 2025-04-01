import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  
  // CORS 설정 추가
  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type'],
  });

  const port = process.env.PORT || 3001;
  
  // 모든 인터페이스에서 접속 허용
  await app.listen(port, '0.0.0.0');
  
  logger.log(`Application is running on: http://0.0.0.0:${port}`);
  logger.log(`WebSocket server is running on: ws://0.0.0.0:${port}`);
}
bootstrap(); 