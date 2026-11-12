import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

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
}
