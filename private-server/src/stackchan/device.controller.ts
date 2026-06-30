import { Controller, Get, Logger, Post } from '@nestjs/common';
import { ok } from './api-response';
import { DeviceStateService } from './device-state.service';

/**
 * The HTTP surface the StackChan firmware actually calls on the avatar/app
 * backend (firmware/main/hal/hal_account.cpp + hal_app_center.cpp):
 *
 *   GET  /stackChan/device/user    -> bound username
 *   GET  /stackChan/device/info    -> device display name
 *   POST /stackChan/device/unbind  -> unbind from account
 *   GET  /stackChan/apps           -> app-store list
 *
 * Auth is not enforced here: the stock firmware sends a hardcoded
 * `Authorization: hi-stack-chan` header, which this dev server ignores.
 */
@Controller('stackChan')
export class DeviceController {
  private readonly logger = new Logger('DeviceHTTP');

  constructor(private readonly state: DeviceStateService) {}

  /** Firmware: hal_account.cpp `fetch_username` (accepts string or {username}). */
  @Get('device/user')
  getUser() {
    const user = this.state.getUser();
    this.logger.log(`GET /device/user -> ${user ? user.username : '(unbound)'}`);
    return ok(user);
  }

  /** Firmware: hal_account.cpp `fetch_device_name` (reads data.name). */
  @Get('device/info')
  getDeviceInfo() {
    const name = this.state.getDeviceName();
    this.logger.log(`GET /device/info -> name="${name}"`);
    return ok({ name });
  }

  /** Firmware: hal_account.cpp `unbindAccount` (checks code === 0). */
  @Post('device/unbind')
  unbind() {
    this.state.unbind();
    this.logger.log('POST /device/unbind -> unbound');
    return ok(true);
  }

  /**
   * Firmware: hal_app_center.cpp `fetchAppList`. Each entry's `firmwareUrl` is
   * fed to the OTA updater when the user launches the app, so the sample URLs
   * below are intentionally inert placeholders — they will simply fail to
   * download rather than flash anything. Replace with real OTA images to test.
   */
  @Get('apps')
  getApps() {
    this.logger.log('GET /apps');
    return ok([
      {
        appName: 'Sample App',
        iconUrl: '',
        description: 'Placeholder app served by the local private-server.',
        firmwareUrl: '',
      },
    ]);
  }
}
