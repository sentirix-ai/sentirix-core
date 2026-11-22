import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AttachmentDto {
  @ApiProperty({ example: 'invoice_error.png' })
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @ApiProperty({ example: 'image/png' })
  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @ApiProperty({ description: 'Base64 encoded file data or Data URL' })
  @IsString()
  @IsNotEmpty()
  data: string;
}
