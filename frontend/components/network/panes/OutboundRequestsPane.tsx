import React from 'react';
import { ProxiedRequests } from '../../../pages/ProxiedRequests';

/** Server-originated requests made through DarkRide's configured proxy pool. */
export function OutboundRequestsPane() {
  return <div data-testid="pane-outbound"><ProxiedRequests /></div>;
}
