import Phaser from 'phaser'
import { Net } from '../net/socket'

/**
 * M0 placeholder scene. It exists to prove the transport works end to end: it
 * connects, round-trips an echo, and reports the transport in use.
 *
 * Replaced by the real Boot → Sandbox/Game flow in M3/M6.
 */
export class BootScene extends Phaser.Scene {
  private net!: Net
  private status!: Phaser.GameObjects.Text
  private detail!: Phaser.GameObjects.Text
  private sentAt = 0

  constructor() {
    super('Boot')
  }

  create(): void {
    const cx = this.scale.width / 2

    this.add
      .text(cx, 220, 'DEATHMATCH', {
        fontFamily: 'monospace',
        fontSize: '56px',
        color: '#dbe7ff',
      })
      .setOrigin(0.5)

    this.status = this.add
      .text(cx, 320, 'connecting…', {
        fontFamily: 'monospace',
        fontSize: '22px',
        color: '#8fb7ff',
      })
      .setOrigin(0.5)

    this.detail = this.add
      .text(cx, 370, '', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#5f7fae',
        align: 'center',
      })
      .setOrigin(0.5)

    this.net = new Net()

    this.net.on('echo_back', (...args: unknown[]) => {
      const rtt = Math.round(performance.now() - this.sentAt)
      const payload = JSON.stringify(args[0] ?? null)
      this.status.setText('connected')
      this.status.setColor('#7ce38b')
      this.detail.setText(
        [`echo_back ${payload}`, `round trip ${rtt} ms`, `transport ${this.net.transport ?? '?'}`].join(
          '\n',
        ),
      )
      // The transport line is the one that matters: a working-but-polling socket
      // looks like lag rather than like a misconfiguration.
      console.info('[net] echo_back', payload, 'rtt', rtt, 'transport', this.net.transport)
    })

    this.net.onState((s) => {
      if (s === 'connected') {
        this.sentAt = performance.now()
        this.net.emit('echo', { n: 42, t: this.sentAt })
      } else if (s === 'disconnected') {
        this.status.setText('disconnected')
        this.status.setColor('#e37c7c')
      }
    })

    this.net.connect()
  }
}
