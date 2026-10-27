import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard, RolesGuard, GitHubOAuthGuard } from './guards';
import { GitHubOAuthService } from './github-oauth.service';
import { DatabaseService } from '../database.service';
import { RedisService } from '../redis.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    GitHubOAuthService,
    DatabaseService,
    RedisService,
    JwtAuthGuard,
    RolesGuard,
    GitHubOAuthGuard,
  ],
  exports: [AuthService, GitHubOAuthService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
