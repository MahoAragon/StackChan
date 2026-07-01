import { Module } from '@nestjs/common';
import { StackchanModule } from './stackchan/stackchan.module';
import { XiaozhiModule } from './xiaozhi/xiaozhi.module';

@Module({
  imports: [StackchanModule, XiaozhiModule],
})
export class AppModule {}
