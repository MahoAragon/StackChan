import { Module } from '@nestjs/common';
import { AvatarWsService } from './avatar-ws.service';
import { ControlController } from './control.controller';
import { DeviceController } from './device.controller';
import { DeviceStateService } from './device-state.service';

@Module({
  controllers: [DeviceController, ControlController],
  providers: [AvatarWsService, DeviceStateService],
  exports: [AvatarWsService],
})
export class StackchanModule {}
