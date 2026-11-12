# The SymCache builder's container (src/bin/builder.rs), for debug files over the worker's 48 MB: wrangler builds it
# with Docker on deploy when wrangler.local.json has the container (docs/deploying.md)
FROM rust:1-bookworm@sha256:c9155318d07341301a78b45ecdd81af2e43b8b297d64e8fd4c5e80d7735607c3 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --features builder --bin builder

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
COPY --from=build /src/target/release/builder /usr/local/bin/builder
EXPOSE 8080
CMD ["builder"]
