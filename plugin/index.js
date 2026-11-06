/*
 * gw-autostart
 *
 * DSH 启动时自动拉起网页版 DeepSeek 网关。
 * apply 时 spawn start-gateway.sh，该脚本幂等，网关已在运行则跳过。
 * 所有错误都被吞掉，不影响 DSH 本身启动。
 */
import { spawn } from 'node:child_process';

const name = 'gw-autostart';

function apply() {
  try {
    const child = spawn('bash', ['/data/dsh/home/start-gateway.sh'], {
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 任何失败都不影响 DSH 启动
  }
}

export { apply, name };
