import {
  envelope,
  toDefinitionRequestDto,
} from '@/modules/definition-requests/dto/definition-request-response.dto';
import { definitionRequestRow } from '../support/definition-requests-doubles';

describe('toDefinitionRequestDto', () => {
  it('maps every field, converting dates to ISO strings', () => {
    const row = definitionRequestRow({
      reviewedAt: new Date('2026-02-01T00:00:00.000Z'),
      fulfilledAt: new Date('2026-02-02T00:00:00.000Z'),
    });
    const dto = toDefinitionRequestDto(row);

    expect(dto.id).toBe(row.id);
    expect(dto.requestType).toBe('new_rule');
    expect(dto.reviewedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(dto.fulfilledAt).toBe('2026-02-02T00:00:00.000Z');
    expect(dto.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('leaves null dates as null', () => {
    const row = definitionRequestRow({ reviewedAt: null, fulfilledAt: null });
    const dto = toDefinitionRequestDto(row);
    expect(dto.reviewedAt).toBeNull();
    expect(dto.fulfilledAt).toBeNull();
  });
});

describe('envelope', () => {
  it('wraps the payload under data', () => {
    expect(envelope({ id: 1 })).toEqual({ data: { id: 1 } });
  });
});
