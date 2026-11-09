import { Injectable } from '@nestjs/common';
import { CreatePcrStrategyDto } from './dto/create-pcr-strategy.dto';
import { UpdatePcrStrategyDto } from './dto/update-pcr-strategy.dto';

@Injectable()
export class PcrStrategyService {
  create(createPcrStrategyDto: CreatePcrStrategyDto) {
    return 'This action adds a new pcrStrategy';
  }

  findAll() {
    return `This action returns all pcrStrategy`;
  }

  findOne(id: number) {
    return `This action returns a #${id} pcrStrategy`;
  }

  update(id: number, updatePcrStrategyDto: UpdatePcrStrategyDto) {
    return `This action updates a #${id} pcrStrategy`;
  }

  remove(id: number) {
    return `This action removes a #${id} pcrStrategy`;
  }
}
