import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MongoRepository } from 'typeorm';
import { ObjectId } from 'mongodb';
import { PcrStrategyConfigEntity } from './entities/pcr-strategy-config.entity';
import { CreatePcrStrategyConfigDto } from './dto/create-pcr-strategy-config.dto';
import { UpdatePcrStrategyConfigDto } from './dto/update-pcr-strategy-config.dto';

const UPPER_FIELDS = [
  'contractName',
  'pcrExchange',
  'pcrExpiry',
  'tradeExchange',
  'tradeInstrumentType',
  'tradeContractName',
  'tradeExpiry',
  'side',
  'status',
  'productType',
  'underlyingExchange',
];

@Injectable()
export class PcrStrategyConfigService {
  constructor(
    @InjectRepository(PcrStrategyConfigEntity)
    private readonly repo: MongoRepository<PcrStrategyConfigEntity>,
  ) {}

  private normalize<T extends object>(dto: T): T {
    const out: any = { ...dto };
    for (const k of UPPER_FIELDS) {
      if (typeof out[k] === 'string') out[k] = out[k].trim().toUpperCase();
    }
    if (out.underlyingToken !== undefined)
      out.underlyingToken = String(out.underlyingToken).trim();
    return out;
  }

  private oid(id: string) {
    if (!ObjectId.isValid(id))
      throw new BadRequestException('Invalid Mongo ID');
    return new ObjectId(id);
  }

  private async assertNoDuplicate(
    contractName: string,
    pcrExpiry: string,
    excludeId?: string,
  ) {
    const found = await this.repo.findOne({
      where: { contractName, pcrExpiry },
    });
    if (found && String(found.id) !== excludeId) {
      throw new ConflictException(
        `Configuration for ${contractName} with expiry ${pcrExpiry} already exists`,
      );
    }
  }

  async create(dto: CreatePcrStrategyConfigDto) {
    const data = this.normalize(dto);
    await this.assertNoDuplicate(data.contractName, data.pcrExpiry);
    try {
      const entity = this.repo.create({
        pcrStartLevel: 1,
        pcrStep: 0.1,
        productType: 'M',
        status: 'INACTIVE', // safe default
        ...data,
      });
      return await this.repo.save(entity);
    } catch (e: any) {
      if (e?.code === 11000) {
        throw new ConflictException(
          `Configuration for ${data.contractName} with expiry ${data.pcrExpiry} already exists`,
        );
      }
      throw new InternalServerErrorException(
        'Failed to save PCR configuration',
      );
    }
  }

  findAll() {
    return this.repo.find();
  }

  getActiveConfigs() {
    return this.repo.find({ where: { status: 'ACTIVE' } });
  }

  async findById(id: string) {
    const cfg = await this.repo.findOneBy({ _id: this.oid(id) } as any);
    if (!cfg) throw new NotFoundException('PCR configuration not found');
    return cfg;
  }

  async update(id: string, dto: UpdatePcrStrategyConfigDto) {
    const existing = await this.findById(id);
    const data = this.normalize(dto);
    const name = data.contractName ?? existing.contractName;
    const expiry = data.pcrExpiry ?? existing.pcrExpiry;
    if (name !== existing.contractName || expiry !== existing.pcrExpiry) {
      await this.assertNoDuplicate(name, expiry, id);
    }
    Object.assign(existing, data);
    return this.repo.save(existing);
  }

  async setStatus(id: string, status: string) {
    const existing = await this.findById(id);
    existing.status = status;
    return this.repo.save(existing);
  }

  async remove(id: string) {
    await this.findById(id);
    await this.repo.delete(this.oid(id));
    return { success: true, message: 'PCR configuration deleted', id };
  }
}
