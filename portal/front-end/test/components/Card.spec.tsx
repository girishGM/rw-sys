import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, CardBody, CardFooter, CardHeader } from '../../src/components/Card';

describe('Card', () => {
  it('TC-1: renders header, body and footer regions', () => {
    render(
      <Card>
        <CardHeader>Title</CardHeader>
        <CardBody>Body content</CardBody>
        <CardFooter>Footer action</CardFooter>
      </Card>,
    );
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Body content')).toBeInTheDocument();
    expect(screen.getByText('Footer action')).toBeInTheDocument();
  });
});
