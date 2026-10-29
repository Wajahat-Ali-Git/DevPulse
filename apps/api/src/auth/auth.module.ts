import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard, RolesGuard, GitHubOAuthGuard } from './guards';
import { GitHubOAuthService } from './github-oauth.service';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';

import { TokenEncryptionService } from './token-encryption.service';

@Module({
  controllers: [AuthController],
  providers: [
    TokenEncryptionService,
    AuthService,
    GitHubOAuthService,
    DatabaseService,
    RedisService,
    JwtAuthGuard,
    RolesGuard,
    GitHubOAuthGuard,
  ],
  exports: [TokenEncryptionService, AuthService, GitHubOAuthService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
