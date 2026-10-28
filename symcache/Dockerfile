# The SymCache builder's container (src/bin/builder.rs), for debug files over the worker's 48 MB: wrangler builds it
# with Docker on deploy when wrangler.local.json has the container (docs/deploying.md)
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --features builder --bin builder

FROM debian:bookworm-slim
COPY --from=build /src/target/release/builder /usr/local/bin/builder
EXPOSE 8080
CMD ["builder"]
