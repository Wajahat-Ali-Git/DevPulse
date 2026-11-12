import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators';
import { AuthTokenPayload } from '@devpulse/types';
import { RepositorySyncService } from './repository-sync.service';
import { InitiateSyncDto } from './dto/initiate-sync.dto';
import { InitiateSyncResponseDto } from './types';

@Controller('repositories')
export class RepositoriesController {
  constructor(private readonly repositorySyncService: RepositorySyncService) {}

  /**
   * Initiates asynchronous repository synchronization for the authenticated user.
   * Validates that the requested GitHub account belongs to the user and that the user
   * has workspace membership.
   *
   * POST /api/v1/repositories/sync
   */
  @Post('sync')
  @HttpCode(HttpStatus.ACCEPTED)
  async initiateSync(
    @CurrentUser() user: AuthTokenPayload,
    @Body() dto: InitiateSyncDto,
  ): Promise<InitiateSyncResponseDto> {
    return this.repositorySyncService.enqueueRepositorySync(user.sub, dto);
  }

  /**
   * Lists repositories for the authenticated user with multi-tenant workspace filtering and pagination.
   *
   * GET /api/v1/repositories
   */
  @Get()
  async listRepositories(
    @CurrentUser() user: AuthTokenPayload,
    @Query('workspaceId') workspaceId?: string,
    @Query('status') status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
  ) {
    return this.repositorySyncService.listUserRepositories(user.sub, {
      workspaceId,
      status,
      search,
      page: page ? parseInt(page, 10) : undefined,
      perPage: perPage ? parseInt(perPage, 10) : undefined,
    });
  }
}
