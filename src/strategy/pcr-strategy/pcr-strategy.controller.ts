import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PcrStrategyConfigService } from './pcr-strategy-config.service';
import { PcrCalculationService } from './pcr-calculation.service';
import { PcrExecutionService } from './pcr-execution.service';
import { CreatePcrStrategyConfigDto } from './dto/create-pcr-strategy-config.dto';
import {
  UpdatePcrStatusDto,
  UpdatePcrStrategyConfigDto,
} from './dto/update-pcr-strategy-config.dto';

@Controller('pcr-strategy')
export class PcrStrategyController {
  constructor(
    private readonly configService: PcrStrategyConfigService,
    private readonly calc: PcrCalculationService,
    private readonly exec: PcrExecutionService,
  ) {}

  @Post('config') create(@Body() dto: CreatePcrStrategyConfigDto) {
    return this.configService.create(dto);
  }
  @Get('config') findAll() {
    return this.configService.findAll();
  }
  @Get('config/:id') findOne(@Param('id') id: string) {
    return this.configService.findById(id);
  }
  @Patch('config/:id') update(
    @Param('id') id: string,
    @Body() dto: UpdatePcrStrategyConfigDto,
  ) {
    return this.configService.update(id, dto);
  }
  @Patch('config/:id/status') setStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePcrStatusDto,
  ) {
    return this.configService.setStatus(id, dto.status);
  }
  @Delete('config/:id') remove(@Param('id') id: string) {
    return this.configService.remove(id);
  }

  // live JSON snapshots
  @Get('live') live() {
    return this.calc.readAllSnapshots();
  }
  @Get('live/:id') async liveOne(@Param('id') id: string) {
    const cfg = await this.configService.findById(id);
    return this.calc.readSnapshot(cfg);
  }

  // force one rebalance now (respects ACTIVE + dry-run flag)
  @Post('config/:id/execute') execute(@Param('id') id: string) {
    return this.exec.runNow(id);
  }
}
