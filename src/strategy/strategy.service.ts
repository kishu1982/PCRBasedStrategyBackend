import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);
  private readonly TRADINGVIEW_SECRET =
    process.env.TRADINGVIEW_SECRET || 'tv_secret_123';

  constructor() {}

  /**
   * Called for every tick coming from WebSocket
   */
}
