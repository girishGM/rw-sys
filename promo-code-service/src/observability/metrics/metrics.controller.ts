/**
 * T-PC-042. `GET /metrics` — a standard, scrapable Prometheus text-exposition-format endpoint
 * (implementation note 3), consistent with what any typical NestJS/Node service exposes, so the
 * actual dashboard-building work (explicitly out of this task's scope) is unblocked whenever
 * someone picks it up. `Content-Type: text/plain; version=0.0.4` is the exposition format's own
 * documented media type.
 */
import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    return this.metricsService.render();
  }
}
