import { Injectable } from '@nestjs/common';

/**
 * In-memory stand-in for the device/user binding that the production server
 * keeps in MySQL. The firmware polls these over HTTP to decide whether it is
 * bound to an account and what name to display.
 */
@Injectable()
export class DeviceStateService {
  /** Username the device is "bound" to. null => unbound. */
  private username: string | null = 'LocalDev';
  /** Display name reported by GET /stackChan/device/info. */
  private deviceName = 'StackChan';

  getUser(): { username: string } | null {
    return this.username ? { username: this.username } : null;
  }

  setUser(username: string | null) {
    this.username = username;
  }

  getDeviceName(): string {
    return this.deviceName;
  }

  setDeviceName(name: string) {
    this.deviceName = name;
  }

  unbind() {
    this.username = null;
  }
}
