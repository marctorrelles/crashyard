# The SymCache builder's container (src/bin/builder.rs), for debug files over the worker's 48 MB: wrangler builds it
# with Docker on deploy when wrangler.local.json has the container (docs/deploying.md)
FROM rust:1-bookworm@sha256:c9155318d07341301a78b45ecdd81af2e43b8b297d64e8fd4c5e80d7735607c3 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --features builder --bin builder

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
COPY --from=build /src/target/release/builder /usr/local/bin/builder
EXPOSE 8080
CMD ["builder"]
