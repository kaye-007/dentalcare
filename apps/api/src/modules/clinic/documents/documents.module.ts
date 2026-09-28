import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/clinic/auth';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import {
  PatientDocumentsController,
  PatientPhotoController,
} from './patient-documents.controller';

@Module({
  imports: [AuthModule],
  controllers: [PatientDocumentsController, PatientPhotoController, DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
