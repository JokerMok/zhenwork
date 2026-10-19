use std::sync::OnceLock;
use std::time::Duration;

/// One Core process belongs to one employee. The RC2 service credential stays
/// in Web Host; Core presents its existing private capability to the bridge.
static AUTHORIZATION: OnceLock<BackgroundAuthorization> = OnceLock::new();

struct BackgroundAuthorization {
    host: &'static str,
    port: u16,
    token: String,
    client: reqwest::Client,
}

impl BackgroundAuthorization {
    fn new(port: u16, token: String) -> Self {
        assert!(port >= 1024, "enterprise cron authorization port invalid");
        assert!(token.len() >= 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "enterprise cron authorization capability invalid");
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .build()
            .expect("enterprise cron authorization client unavailable");
        Self { host: "model-gateway", port, token, client }
    }

    async fn allows(&self, job_id: &str) -> bool {
        if !job_id.starts_with("cron_") || !(13..=85).contains(&job_id.len()) ||
            !job_id[5..].bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') {
            return false;
        }
        let url = format!("http://{}:{}/job/{job_id}", self.host, self.port);
        matches!(self.client.get(url)
            .header("x-aion-enterprise-local-token", &self.token)
            .send().await, Ok(response) if response.status() == reqwest::StatusCode::NO_CONTENT)
    }
}

pub fn install(port: u16, token: String) {
    assert!(AUTHORIZATION.set(BackgroundAuthorization::new(port, token)).is_ok(),
        "enterprise cron authorization already installed");
}

/// Desktop Core has no host background grant service. Enterprise Web Core
/// installs this check before its scheduler starts and fails closed on errors.
pub async fn allows(job_id: &str) -> bool {
    match AUTHORIZATION.get() {
        Some(authorization) => authorization.allows(job_id).await,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn checks_host_at_execution_time() {
        let allowed = Arc::new(AtomicBool::new(true));
        let decision = allowed.clone();
        let token = "a".repeat(64);
        let expected = token.clone();
        let app = axum::Router::new().route("/job/cron_12345678", axum::routing::get(
            move |headers: axum::http::HeaderMap| {
                let decision = decision.clone();
                let expected = expected.clone();
                async move {
                    if headers.get("x-aion-enterprise-local-token").and_then(|value| value.to_str().ok()) != Some(expected.as_str()) {
                        axum::http::StatusCode::FORBIDDEN
                    } else if decision.load(Ordering::SeqCst) {
                        axum::http::StatusCode::NO_CONTENT
                    } else {
                        axum::http::StatusCode::FORBIDDEN
                    }
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        let mut authorization = BackgroundAuthorization::new(port, token);
        authorization.host = "127.0.0.1";
        assert!(authorization.allows("cron_12345678").await);
        allowed.store(false, Ordering::SeqCst);
        assert!(!authorization.allows("cron_12345678").await);
        assert!(!authorization.allows("invalid-id").await);
        server.abort();
    }
}
