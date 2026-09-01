import { MetricsController } from './metrics.controller';
import type { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  it('returns whatever MetricsService.render() produces, verbatim', async () => {
    const rendered = '# HELP x x\n# TYPE x counter\nx 1\n';
    const metricsService = {
      render: jest.fn().mockResolvedValue(rendered),
    } as unknown as MetricsService;
    const controller = new MetricsController(metricsService);

    await expect(controller.getMetrics()).resolves.toBe(rendered);
    expect(metricsService.render).toHaveBeenCalledTimes(1);
  });
});
