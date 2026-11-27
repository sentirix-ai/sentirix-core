import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import express from 'express';
import { AppModule } from './app.module.js';
import { parseCorsOrigins } from './common/security/crypto.util.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Increase payload limit for avatar photo uploads
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  // Enable strict CORS origin whitelist configured via CORS_ORIGIN
  const allowedOrigins = parseCorsOrigins();
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Global prefix for API versioning
  app.setGlobalPrefix('api/v1');

  // Global Validation Pipe for strict DTO type enforcement
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Swagger OpenAPI Documentation (disabled in production to prevent schema leakage)
  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Sevaniq API')
      .setDescription('Sevaniq AI Customer Support & Ticket Resolution Hub API Specification')
      .setVersion('1.0')
      .addTag('Tickets', 'Ticket lifecycle and sentiment operations')
      .addTag('AI', 'Google Gemini integration services')
      .addTag('KnowledgeBase', 'Articles and RAG grounding')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 4000;
  await app.listen(port);

  logger.log(`🚀 Sevaniq Backend Server is running on: http://localhost:${port}/api/v1`);
  if (process.env.NODE_ENV !== 'production') {
    logger.log(`📚 Swagger OpenAPI Documentation available at: http://localhost:${port}/api/docs`);
  }
}

await bootstrap();
