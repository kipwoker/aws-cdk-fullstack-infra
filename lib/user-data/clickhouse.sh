#!/usr/bin/env bash
# Installs ClickHouse and configures a hot/cold storage policy:
#   hot  -> local EBS volume
#   cold -> S3 bucket, using the EC2 instance role (no static keys)
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y apt-transport-https ca-certificates curl gnupg awscli

curl -fsSL https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key \
  | gpg --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg
ARCH=$(dpkg --print-architecture)
echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg arch=${ARCH}] https://packages.clickhouse.com/deb stable main" \
  > /etc/apt/sources.list.d/clickhouse.list

apt-get update
apt-get install -y clickhouse-server clickhouse-client

mkdir -p /etc/clickhouse-server/config.d
cat > /etc/clickhouse-server/config.d/fullstack.xml <<'CLICKHOUSE'
<clickhouse>
  <listen_host>0.0.0.0</listen_host>
  <http_port>{{HTTP_PORT}}</http_port>

  <!-- S3 access uses the EC2 instance profile -->
  <s3>
    <access_key_id>use_instance_role</access_key_id>
    <secret_access_key>use_instance_role</secret_access_key>
  </s3>

  <storage_configuration>
    <disks>
      <s3_disk>
        <type>s3</type>
        <endpoint>https://s3.{{REGION}}.amazonaws.com/{{BUCKET}}/</endpoint>
        <metadata_path>/var/lib/clickhouse/disks/s3_disk/</metadata_path>
      </s3_disk>
      <s3_cache>
        <type>cache</type>
        <disk>s3_disk</disk>
        <path>/var/lib/clickhouse/disks/s3_cache/</path>
        <max_size>{{CACHE_SIZE}}</max_size>
      </s3_cache>
    </disks>
    <policies>
      <tiered>
        <volumes>
          <hot>
            <disk>default</disk>
          </hot>
          <cold>
            <disk>s3_disk</disk>
          </cold>
        </volumes>
        <move_factor>0.2</move_factor>
      </tiered>
    </policies>
  </storage_configuration>

  <merge_tree>
    <storage_policy>tiered</storage_policy>
  </merge_tree>

  <profiles>
    <default>
      <max_memory_usage>{{MAX_MEMORY_BYTES}}</max_memory_usage>
      <async_insert>1</async_insert>
      <wait_for_async_insert>1</wait_for_async_insert>
    </default>
  </profiles>
</clickhouse>
CLICKHOUSE

mkdir -p /var/lib/clickhouse/disks/s3_disk /var/lib/clickhouse/disks/s3_cache
chown -R clickhouse:clickhouse /var/lib/clickhouse

# The default user gets a generated password from Secrets Manager. It is fetched
# with the instance role at boot, so it never lands in user-data or the template.
CLICKHOUSE_PASSWORD=$(aws secretsmanager get-secret-value \
  --region {{REGION}} \
  --secret-id '{{SECRET_ARN}}' \
  --query SecretString \
  --output text)

mkdir -p /etc/clickhouse-server/users.d
cat > /etc/clickhouse-server/users.d/default-user.xml <<USERS
<clickhouse>
  <users>
    <default>
      <password>${CLICKHOUSE_PASSWORD}</password>
      <networks>
        <ip>::/0</ip>
      </networks>
      <profile>default</profile>
      <quota>default</quota>
    </default>
  </users>
</clickhouse>
USERS
chown clickhouse:clickhouse /etc/clickhouse-server/users.d/default-user.xml
chmod 640 /etc/clickhouse-server/users.d/default-user.xml

systemctl enable --now clickhouse-server
systemctl status --no-pager clickhouse-server || true
