import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  app.useStaticAssets(join(__dirname, '..', 'public'));

  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type'],
    credentials: true,
  });

  const port = process.env.PORT || 3002;
  
  await app.listen(port, '0.0.0.0');
  
  logger.log(`Application is running on: http://0.0.0.0:${port}`);
  logger.log(`Serving static files from: ${join(__dirname, '..', 'public')}`);
  logger.log(`WebSocket server is available on port: ${port} (path typically /socket.io)`);
}
bootstrap(); 