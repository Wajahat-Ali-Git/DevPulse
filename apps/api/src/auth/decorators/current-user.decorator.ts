import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthTokenPayload } from '@devpulse/types';

export const CurrentUser = createParamDecorator(
  (data: keyof AuthTokenPayload | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthTokenPayload | undefined;

    if (!user) {
      return null;
    }

    return data ? user[data] : user;
  },
);
