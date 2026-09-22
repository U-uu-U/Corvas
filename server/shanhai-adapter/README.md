# Shanhai video relay adapter

This small private-network service translates the RavenHash/OpenAI-style video
contract to Shanhai's native API. It is intended to run once on each relay
site. The incoming channel `Authorization: Bearer ...` value is passed to
Shanhai for that request; the key is never written to source, the image, or the
SQLite task cache.

Supported relay routes:

- `POST /v1/videos`, `/v1/video/generations`, `/v1/videos/generations`
- `GET /v1/videos/{task}`, `/v1/video/generations/{task}`, `/v1/tasks/{task}`
- `GET /health`

The four public model IDs are kept unchanged: `oc-model-qbdmeb`,
`oc-model-1iq31f`, `oc-model-bkb50q`, and `oc-model-c6ws7e`. The adapter accepts
the usual `duration`/`seconds`, `aspect_ratio`/`ratio`, `resolution`, and image,
video, and audio reference aliases. Reference URLs must already be public
HTTPS URLs. Local uploads belong in the desktop or relay upload layer before a
request reaches this service.

The model limits enforced here are:

- `oc-model-qbdmeb`: 5, 10, or 15 seconds; 720p; at most 10 images.
- `oc-model-1iq31f`: 5-15 seconds; 480p, 720p, or 1080p; at most 9 images.
- `oc-model-bkb50q` and `oc-model-c6ws7e`: 4-15 seconds; 720p; no references.

Each task is cached in SQLite, partitioned by a hash of the channel key and
task ID. Polling uses a short cache and per-key locks. A submission transport
failure is reported as an unknown outcome and is never retried or submitted a
second time. Completed `output.url` media is downloaded to the shared media
directory. The Bearer key is attached only when the download remains on the
Shanhai origin; redirects to another origin never receive it. The response
then exposes the configured `PUBLIC_MEDIA` URL instead of forwarding the
supplier URL.

## Run locally

```powershell
python -B -m unittest discover -s server/shanhai-adapter -p test_adapter.py
```

No real Shanhai request is made by the tests.

## Deploy on each relay

Copy this directory to a private deployment path, create `state` owned by UID
1000, and make the shared media directory writable by the container user. Set
`PUBLIC_MEDIA` to the public media URL for that relay. `NETWORK_NAME` defaults
to `tokensbyte-network`; `CONTAINER_NAME` can be changed per host to avoid a
name collision. Then run:

```sh
docker compose -f compose.yml up -d
docker compose -f compose.yml ps
```

Configure the RavenHash channel's base URL to
`http://<container-name>:3011` while keeping its Shanhai `oc_live_...` key as
the channel API key. Do not place the key in `.env` committed to the repository
or in this directory. Before changing an existing channel, snapshot its relay
database and verify `/health` from the relay network. Rollback is the previous
channel base URL plus the old adapter container.
