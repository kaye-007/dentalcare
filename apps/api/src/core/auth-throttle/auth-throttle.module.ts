import { Global, Module } from '@nestjs/common';
import { AuthThrottleService } from './auth-throttle.service';

/** Shared by the clinic's and the console's sign-in (0025). */
@Global()
@Module({
  providers: [AuthThrottleService],
  exports: [AuthThrottleService],
})
export class AuthThrottleModule {}
