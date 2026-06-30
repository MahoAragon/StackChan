import { Module } from '@nestjs/common';
import { StackchanModule } from './stackchan/stackchan.module';

@Module({
  imports: [StackchanModule],
})
export class AppModule {}
