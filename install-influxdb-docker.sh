#!/bin/bash

# 스크립트 실행 중 오류 발생 시 중지
set -e

echo "===== InfluxDB 2.x 설치 스크립트 (Docker) ====="

# 1. 설정 및 데이터 저장을 위한 호스트 디렉토리 생성
INFLUXDB_CONFIG_DIR="/etc/influxdb2"
INFLUXDB_DATA_DIR="/var/lib/influxdb2"

echo ">>> 호스트에 디렉토리 생성 중..."
sudo mkdir -p "$INFLUXDB_CONFIG_DIR"
sudo mkdir -p "$INFLUXDB_DATA_DIR"
# Docker가 해당 디렉토리에 접근할 수 있도록 권한 설정이 필요할 수 있습니다.
# 예: sudo chown -R $(id -u):$(id -g) $INFLUXDB_DATA_DIR $INFLUXDB_CONFIG_DIR
# 또는 Docker 실행 사용자를 해당 디렉토리 그룹에 추가
echo ">>> 디렉토리 생성 완료: $INFLUXDB_CONFIG_DIR, $INFLUXDB_DATA_DIR"

# 2. 최신 안정 InfluxDB 2.x Docker 이미지 가져오기 (예: 2.7 버전 태그 사용)
# 특정 버전을 명시하는 것이 좋습니다. 예: influxdb:2.7.6
INFLUXDB_IMAGE="influxdb:2.7"
echo ">>> InfluxDB Docker 이미지 가져오는 중: $INFLUXDB_IMAGE ..."
sudo docker pull "$INFLUXDB_IMAGE"
echo ">>> 이미지 가져오기 완료."

# 3. 기존 동일 이름의 컨테이너가 있다면 중지 및 삭제 (주의: 데이터는 볼륨에 유지됨)
CONTAINER_NAME="influxdb"
if [ "$(sudo docker ps -aq -f name=^/${CONTAINER_NAME}$)" ]; then
    echo ">>> 기존 InfluxDB 컨테이너($CONTAINER_NAME) 중지 및 삭제 중..."
    sudo docker stop "$CONTAINER_NAME"
    sudo docker rm "$CONTAINER_NAME"
    echo ">>> 기존 컨테이너 삭제 완료."
fi

# 4. InfluxDB 컨테이너 실행
echo ">>> InfluxDB 컨테이너 ($CONTAINER_NAME) 실행 중..."
sudo docker run -d \
  --name "$CONTAINER_NAME" \
  -p 8086:8086 \
  -v "$INFLUXDB_CONFIG_DIR":/etc/influxdb2 \
  -v "$INFLUXDB_DATA_DIR":/var/lib/influxdb2 \
  "$INFLUXDB_IMAGE"

echo ">>> InfluxDB 컨테이너 실행 완료."
echo ">>> 컨테이너 상태 확인:"
sudo docker ps -f name=^/${CONTAINER_NAME}$

echo ""
echo "===== 중요: 다음 단계를 진행하세요 ====="
echo "1. AWS 보안 그룹 설정:"
echo "   - InfluxDB가 설치된 인스턴스의 보안 그룹에서 TCP 포트 8086 인바운드를 허용해야 합니다."
echo "   - 접근을 허용할 IP 주소(예: 애플리케이션 서버 IP, 관리자 IP)를 명시적으로 지정하는 것이 보안상 안전합니다."
echo "   - 예: 1.2.3.4/32 (특정 IP), 10.0.0.0/16 (VPC 내부 대역 등)"
echo ""
echo "2. InfluxDB 초기 설정 (웹 UI 또는 CLI):"
echo "   - 웹 브라우저에서 http://<YOUR_AWS_INSTANCE_IP>:8086 로 접속하여 초기 설정을 진행합니다."
echo "   - 또는 다음 명령어를 사용하여 CLI로 설정할 수 있습니다:"
echo "     sudo docker exec -it $CONTAINER_NAME influx setup \\"
echo "       --username YOUR_ADMIN_USERNAME \\" # 관리자 계정명
echo "       --password YOUR_ADMIN_PASSWORD \\" # 관리자 비밀번호
echo "       --token YOUR_INITIAL_API_TOKEN \\" # 생성될 API 토큰 (기록해두세요!)
echo "       --org YOUR_ORGANIZATION_NAME \\"    # 조직 이름
echo "       --bucket YOUR_INITIAL_BUCKET_NAME \\" # 버킷 이름 (데이터 저장소)
echo "       --retention 0 \\"                   # 데이터 보존 기간 (0 = 무제한)
echo "       -f"
echo "   - 위 CLI 명령어의 YOUR_... 부분을 실제 원하는 값으로 변경하여 실행하세요."
echo "   - **생성된 API 토큰은 lightweight-metrics.config 파일의 [[outputs.influxdb_v2]] 섹션에 필요합니다.**"
echo ""
echo "3. lightweight-metrics.config 업데이트:"
echo "   - 애플리케이션의 lightweight-metrics.config 파일의 [[outputs.influxdb_v2]] 섹션에 위에서 설정한 InfluxDB 정보(URL, 토큰, 조직, 버킷)를 정확히 입력하세요."
echo ""
echo "===== 설치 스크립트 완료 ====="
