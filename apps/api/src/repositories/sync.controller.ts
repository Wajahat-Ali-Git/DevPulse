import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators';
import { AuthTokenPayload } from '@devpulse/types';
import { RepositorySyncService } from './repository-sync.service';
import { InitiateSyncDto } from './dto/initiate-sync.dto';
import {
  InitiateSyncResponseDto,
  SyncJobStatusResponseDto,
  SyncHistoryItemDto,
} from './types';

@Controller('sync')
export class SyncController {
  constructor(private readonly repositorySyncService: RepositorySyncService) {}

  /**
   * Initiates repository synchronization for the authenticated user.
   * Validates GitHub account ownership and user workspace access.
   *
   * POST /api/v1/sync/repositories
   */
  @Post('repositories')
  @HttpCode(HttpStatus.ACCEPTED)
  async initiateRepositoriesSync(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: InitiateSyncDto,
  ): Promise<InitiateSyncResponseDto> {
    return this.repositorySyncService.enqueueRepositorySync(user.sub, dto);
  }

  /**
   * Retrieves synchronization history for the user's accessible workspaces.
   *
   * GET /api/v1/sync/history
   */
  @Get('history')
  async getSyncHistory(
    @CurrentUser() user: AuthTokenPayload,
    @Query('workspaceId') workspaceId?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ): Promise<SyncHistoryItemDto[]> {
    return this.repositorySyncService.getSyncHistory(user.sub, {
      workspaceId,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
    });
  }

  /**
   * Retrieves status for a synchronization job.
   *
   * GET /api/v1/sync/:syncId
   */
  @Get(':syncId')
  async getSyncStatus(
    @CurrentUser() _user: AuthTokenPayload,
    @Param('syncId') syncId: string,
  ): Promise<SyncJobStatusResponseDto> {
    return this.repositorySyncService.getSyncJobStatus(syncId);
  }
}

