import { Link } from '@tanstack/react-router';
import { Compass } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';

export function NotFound() {
  return (
    <EmptyState
      title="This page doesn't exist"
      icon={<Compass />}
      actions={<Link to="/">Go to your workspace</Link>}
    >
      The link may be old, or the page may have moved.
    </EmptyState>
  );
}
