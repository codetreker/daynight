# Agent Note: GitHub App Consumption Components

Status: implemented

## Problem

Independent GitHub Apps grant use to Teams, while Project access and synchronization have separate permissions. Consumers need to select an authorized App without exposing its management data or confusing an old grant or Project owner with the current one. The public Project interface still uses the service-wide App until the server and client protocol change together.

## Decision

The Web module provides a Team read-only projection and a Project consumption component with a dedicated client. The Team projection reads only authorized App identities. Project discovery and connection carry the observed owner, App version and exact grant identity; synchronization settings continue to use Project administration. The Project component retains the existing access admission, management guard, draft and unknown-result handling. Controlled API and browser fixtures exercise the production components; public settings retain the existing client and component.

## Alternatives

**Switch the public Project slot immediately.** The current server speaks the existing service-wide protocol, so switching the client independently would break the live connection flow.

**Read App management resources to populate the Team view.** Team use does not grant App administration, and those resources can expose information outside the Team's authorized projection.

## Consequences

The new consumer can be validated independently while the public flow remains compatible. Actual adoption requires the corresponding server protocol and lifecycle changes together with the public slot. Controlled responses verify frontend behavior but do not establish server authorization, persistence or GitHub connectivity.
