import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

// Envío de correos. Con SMTP configurado (SMTP_HOST) se envía de verdad; sin él, el
// mensaje se escribe en la consola y queda en `outbox`, para desarrollo y pruebas.
// En producción el SMTP es obligatorio: la validación del entorno lo exige.
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;
  readonly outbox: MailMessage[] = [];

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST');
    this.from = config.get<string>('MAIL_FROM') ?? 'Laundry Clean Fresh <no-reply@localhost>';
    this.transporter = host
      ? createTransport({
          host,
          port: config.get<number>('SMTP_PORT') ?? 587,
          secure: config.get<string>('SMTP_SECURE') === 'true',
          auth: config.get<string>('SMTP_USER')
            ? { user: config.get<string>('SMTP_USER'), pass: config.get<string>('SMTP_PASS') }
            : undefined,
        })
      : null;
  }

  get configured(): boolean {
    return this.transporter !== null;
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.outbox.push(message);
      if (this.outbox.length > 50) this.outbox.shift();
      this.logger.warn(
        `SMTP sin configurar: correo no enviado a ${message.to}.\n${message.subject}\n${message.text}`,
      );
      return;
    }
    await this.transporter.sendMail({ from: this.from, ...message });
  }
}
