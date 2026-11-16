import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';
import { SyncScope } from '@devpulse/types';

export class InitiateSyncDto {
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @IsString()
  @IsOptional()
  githubAccountId?: string;

  @IsBoolean()
  @IsOptional()
  forced?: boolean;

  @IsString()
  @IsOptional()
  scope?: SyncScope | string;
}

