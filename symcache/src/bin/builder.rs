//! The SymCache builder, run natively in a Cloudflare Container for debug files too big for the worker (a Worker has
//! 128 MB; a 107 MB dSYM takes about 330 MB to convert). The same code as the Wasm module, over plain HTTP on 8080:
//!
//! - `GET /health`: ok, once it's listening.
//! - `POST /objects`, the file as the body: its objects, as `objects()` gives them.
//! - `POST /symcache?id=<debug id>`, the file as the body: that object's SymCache, its length in `x-length`, or 422
//!   with `{"error"}`.

use crashyard_symcache::{list_objects, make_symcache};
use tiny_http::{Header, Method, Response, Server};

fn main() {
    let server = Server::http("0.0.0.0:8080").expect("listen on 8080");
    let json = Header::from_bytes("content-type", "application/json").unwrap();
    for mut request in server.incoming_requests() {
        let url = request.url().to_string();
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        let read = |request: &mut tiny_http::Request| {
            let mut body = Vec::with_capacity(request.body_length().unwrap_or(0));
            request.as_reader().read_to_end(&mut body).map(|_| body)
        };
        let answer = match (request.method(), path) {
            (Method::Get, "/health") => Response::from_string("ok").boxed(),
            (Method::Post, "/objects") => match read(&mut request).map_err(|e| e.to_string()).and_then(|b| list_objects(&b)) {
                Ok(objects) => Response::from_string(objects.to_string()).with_header(json.clone()).boxed(),
                Err(e) => failed(&e, &json),
            },
            (Method::Post, "/symcache") => {
                let id = query.strip_prefix("id=").unwrap_or("").to_string();
                match read(&mut request).map_err(|e| e.to_string()).and_then(|b| make_symcache(&b, &id)) {
                    // Its length again in a header of its own: Content-Length doesn't survive the Durable Object
                    Ok(cache) => {
                        let length = Header::from_bytes("x-length", cache.len().to_string()).unwrap();
                        Response::from_data(cache).with_header(length).boxed()
                    }
                    Err(e) => failed(&e, &json),
                }
            }
            _ => Response::from_string("not found").with_status_code(404).boxed(),
        };
        let _ = request.respond(answer);
    }
}

fn failed(message: &str, json: &Header) -> tiny_http::ResponseBox {
    Response::from_string(serde_json::json!({ "error": message }).to_string())
        .with_status_code(422)
        .with_header(json.clone())
        .boxed()
}
