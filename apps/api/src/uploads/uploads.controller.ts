import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { UploadsService } from './uploads.service.js';

interface UploadResponse {
  id: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  createdAt: string;
}

@Controller('uploads')
@UseGuards(AuthGuard)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ): Promise<UploadResponse> {
    if (!req.isMultipart()) {
      throw new BadRequestException({
        error: 'multipart_required',
        message: 'POST /uploads requires multipart/form-data',
      });
    }
    const file = await req.file();
    if (!file) {
      throw new BadRequestException({
        error: 'file_missing',
        message: 'no file part in multipart request',
      });
    }
    const buffer = await file.toBuffer();
    const row = await this.uploads.create({
      buffer,
      mimeType: file.mimetype,
      userId: user?.id ?? null,
    });
    return {
      id: row.id,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes.toString(),
      sha256: row.sha256,
      createdAt: row.createdAt.toISOString(),
    };
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<UploadResponse> {
    const row = await this.uploads.findById(id);
    if (!row) throw new NotFoundException(`upload ${id} not found`);
    return {
      id: row.id,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes.toString(),
      sha256: row.sha256,
      createdAt: row.createdAt.toISOString(),
    };
  }

  @Get(':id/bytes')
  async bytes(@Param('id') id: string, @Res() reply: FastifyReply): Promise<void> {
    const row = await this.uploads.findById(id);
    if (!row) throw new NotFoundException(`upload ${id} not found`);
    const buffer = await this.uploads.getBytes(id);
    reply.header('content-type', row.mimeType);
    reply.header('content-length', buffer.length.toString());
    reply.send(buffer);
  }
}
