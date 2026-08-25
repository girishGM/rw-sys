import {
  DefinitionRequestInvalidTransitionError,
  DefinitionRequestVersionNotPublishedError,
  EntityIdNotAllowedError,
  EntityIdRequiredError,
  RejectionCommentRequiredError,
} from '@/modules/definition-requests/definition-requests.errors';

describe('definition-requests.errors — HTTP status mapping', () => {
  it('EntityIdRequiredError is 400 with an entityId/REQUIRED detail', () => {
    const error = new EntityIdRequiredError();
    expect(error.status).toBe(400);
    expect(error.details).toEqual([{ field: 'entityId', code: 'REQUIRED' }]);
  });

  it('EntityIdNotAllowedError is 400 with an entityId/NOT_ALLOWED detail', () => {
    const error = new EntityIdNotAllowedError();
    expect(error.status).toBe(400);
    expect(error.details).toEqual([{ field: 'entityId', code: 'NOT_ALLOWED' }]);
  });

  it('DefinitionRequestInvalidTransitionError is 409', () => {
    const error = new DefinitionRequestInvalidTransitionError('submitted', 'fulfilled');
    expect(error.status).toBe(409);
  });

  it('RejectionCommentRequiredError is 400 with a reviewComment/REQUIRED detail (TC-10)', () => {
    const error = new RejectionCommentRequiredError();
    expect(error.status).toBe(400);
    expect(error.details).toEqual([{ field: 'reviewComment', code: 'REQUIRED' }]);
  });

  it('DefinitionRequestVersionNotPublishedError is 422 (TC-14)', () => {
    const error = new DefinitionRequestVersionNotPublishedError();
    expect(error.status).toBe(422);
  });
});
