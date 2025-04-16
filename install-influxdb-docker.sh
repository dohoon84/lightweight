#!/bin/bash
set -e

echo "===== 커스텀 InfluxDB 2.x 설치 스크립트 (Docker + Non-root) ====="

# 설정
IMAGE_NAME="custom-influxdb:2.7"
CONTAINER_NAME="influxdb"
INFLUXDB_CONFIG_DIR="./influxdb2-config"
INFLUXDB_DATA_DIR="./influxdb2-data"
UID_GID="1000:1000"

echo ">>> 디렉토리 생성 및 권한 설정..."
mkdir -p "$INFLUXDB_CONFIG_DIR" "$INFLUXDB_DATA_DIR"
mkdir -p "$INFLUXDB_DATA_DIR/engine"
sudo chown -R 1000:1000 influxdb2-data
sudo chown -R 1000:1000 "$INFLUXDB_CONFIG_DIR" "$INFLUXDB_DATA_DIR"
sudo chmod -R 757 "$INFLUXDB_CONFIG_DIR" "$INFLUXDB_DATA_DIR"

# Dockerfile 생성
echo ">>> Dockerfile 생성 중..."
cat > Dockerfile.influxdb <<'EOF'
FROM influxdb:2.7

# influxdb 유저가 존재하지 않을 경우에만 생성
RUN getent group influxdb || groupadd -g 1000 influxdb && \
    id influxdb || useradd -u 1000 -g influxdb -m -s /bin/bash influxdb

# 디렉토리 권한 재설정
RUN mkdir -p /var/lib/influxdb2 /etc/influxdb2 && \
    chown -R influxdb:influxdb /var/lib/influxdb2 /etc/influxdb2

USER influxdb

ENTRYPOINT ["/entrypoint.sh"]
CMD ["influxd"]
EOF

echo ">>> Docker 이미지 빌드 시작: $IMAGE_NAME ..."
docker build -f Dockerfile.influxdb -t $IMAGE_NAME .
echo ">>> Docker 이미지 빌드 완료."

# 기존 컨테이너 제거
if docker ps -aq -f name=^/${CONTAINER_NAME}$ > /dev/null; then
    echo ">>> 기존 컨테이너 중지 및 제거 중..."
    docker rm -f "$CONTAINER_NAME"
fi

# 컨테이너 실행
echo ">>> 컨테이너 실행 중..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -p 8086:8086 \
  -v "$PWD/$INFLUXDB_CONFIG_DIR":/etc/influxdb2 \
  -v "$PWD/$INFLUXDB_DATA_DIR":/var/lib/influxdb2 \
  "$IMAGE_NAME"

echo ">>> 컨테이너 실행 완료. 상태:"
docker ps -f name=^/${CONTAINER_NAME}$

# 마무리 안내
cat <<EOM

===== 설치 완료 =====

1. 웹 브라우저에서 http://<YOUR_AWS_INSTANCE_IP>:8086 접속
2. 또는 초기 CLI 설정:

   docker exec -it $CONTAINER_NAME influx setup \\
     --username YOUR_ADMIN_USERNAME \\
     --password YOUR_ADMIN_PASSWORD \\
     --token YOUR_INITIAL_API_TOKEN \\
     --org YOUR_ORG_NAME \\
     --bucket YOUR_BUCKET_NAME \\
     --retention 0 \\
     -f

* 설정 후 생성된 토큰과 정보를 앱의 config에 반영하세요.
EOM
