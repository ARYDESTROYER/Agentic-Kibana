/**
 * ui/tabs — Round-7 W0.1. TabsContent fades in by default (Radix mounts only the active
 * panel, so this replays on tab-switch, not on every render); `animate={false}` opts a
 * panel out. Reduced motion is neutralised globally by the theme.css reset.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../tabs';

function renderTabs(animate?: boolean) {
  return render(
    <Tabs defaultValue="a">
      <TabsList>
        <TabsTrigger value="a">A</TabsTrigger>
      </TabsList>
      <TabsContent value="a" animate={animate}>
        Panel A
      </TabsContent>
    </Tabs>,
  );
}

describe('TabsContent fade', () => {
  it('fades in by default', () => {
    renderTabs();
    expect(screen.getByText('Panel A').className).toContain('animate-fade-in');
  });

  it('animate={false} opts the panel out of the fade', () => {
    renderTabs(false);
    expect(screen.getByText('Panel A').className).not.toContain('animate-fade-in');
  });

  it('still forwards a custom className', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
        <TabsContent value="a" className="space-y-4">
          Body
        </TabsContent>
      </Tabs>,
    );
    const el = screen.getByText('Body');
    expect(el.className).toContain('animate-fade-in');
    expect(el.className).toContain('space-y-4');
  });
});
