import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  AllowWithoutKyc,
  CurrentUser,
  Roles,
  type AuthUser,
} from '../common/decorators/auth.decorators';
import { ReviewKycDto, SubmitKycDto } from './dto/kyc.dto';
import { KycService, MAX_KYC_IMAGE_BYTES } from './kyc.service';

const DOCUMENT_TYPES = {
  SELFIE: 'SELFIE',
  ID_FRONT: 'ID_FRONT',
  ID_BACK: 'ID_BACK',
} as const;
type DocumentType = keyof typeof DOCUMENT_TYPES;
const DOCUMENT_TYPE_PIPE = new ParseEnumPipe(DOCUMENT_TYPES);

@AllowWithoutKyc()
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Roles('CLIENT')
  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.kyc.mine(user);
  }

  // Sube (o reemplaza) una imagen del envío en curso: SELFIE, ID_FRONT o ID_BACK.
  @Roles('CLIENT')
  @Put('me/documents/:type')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_KYC_IMAGE_BYTES, files: 1 } }),
  )
  upload(
    @CurrentUser() user: AuthUser,
    @Param('type', DOCUMENT_TYPE_PIPE) type: DocumentType,
    @UploadedFile() file?: { buffer: Buffer },
  ) {
    return this.kyc.uploadDocument(user, type, file);
  }

  // Envía a revisión; exige las tres imágenes y el número de cédula.
  @Roles('CLIENT')
  @Post('me/submit')
  submit(@CurrentUser() user: AuthUser, @Body() dto: SubmitKycDto) {
    return this.kyc.submit(user, dto);
  }

  // Cola de revisión: por defecto, las verificaciones pendientes.
  @Roles('ADMIN')
  @Get()
  queue(@Query('status') status?: string) {
    return this.kyc.queue(status);
  }

  @Roles('ADMIN')
  @Get(':customerId')
  detail(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.kyc.detail(customerId);
  }

  // Imagen de un documento; cada consulta queda auditada y nunca se guarda en caché.
  @Roles('ADMIN')
  @Get(':customerId/documents/:type')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async document(
    @CurrentUser() actor: AuthUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('type', DOCUMENT_TYPE_PIPE) type: DocumentType,
  ) {
    const { data, mimeType } = await this.kyc.document(actor, customerId, type);
    return new StreamableFile(data, { type: mimeType, disposition: 'inline' });
  }

  @Roles('ADMIN')
  @Post(':customerId/review')
  review(
    @CurrentUser() actor: AuthUser,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: ReviewKycDto,
  ) {
    return this.kyc.review(actor, customerId, dto);
  }
}
