-- Old RavenHash relay only. Back up the database before applying.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE models, billing_rules, channels, model_providers, model_api_providers, channel_categories IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
    template models%ROWTYPE;
    billing billing_rules%ROWTYPE;
    channel channels%ROWTYPE;
    currency JSONB;
    exchange NUMERIC;
    rate NUMERIC;
    new_mid TEXT;
    new_billing BIGINT;
    public_group BIGINT;
    api_group BIGINT;
    channel_group BIGINT;
BEGIN
    SELECT * INTO STRICT template FROM models WHERE model_id = 'seedance_v2.5' AND is_active = 1;
    SELECT * INTO STRICT billing FROM billing_rules WHERE id = template.billing_rule_id;
    SELECT * INTO STRICT channel FROM channels
      WHERE base_url IN ('https://video.zhubo.asia', 'https://video.zhubo.asia/v1') AND status=1;
    IF NOT (channel.models::jsonb ? template.mid) OR template.forward_rule_ids <> '[37]' THEN
        RAISE EXCEPTION 'Unexpected existing Zhubo route; inspect before applying';
    END IF;
    IF EXISTS (SELECT 1 FROM models WHERE model_id='seedance-2.5-pro') THEN
        RAISE EXCEPTION 'Pro already exists; refusing to duplicate';
    END IF;
    SELECT value::jsonb INTO STRICT currency FROM settings WHERE key='currency_settings';
    SELECT (entry->>'exchange_rate')::numeric INTO STRICT exchange
      FROM jsonb_array_elements(currency->'auxiliary_currencies') entry
      WHERE entry->>'code'='CNY' AND (entry->>'enabled')::boolean;
    IF currency->>'default_currency' <> 'USD' OR exchange <= 0
       OR billing.billing_type <> 'requests' OR abs(billing.fixed_rate * exchange - 5) > 0.001 THEN
        RAISE EXCEPTION 'Existing currency or HM billing contract changed';
    END IF;
    rate := 1.06 / exchange;
    SELECT id INTO public_group FROM model_providers WHERE name='主播视频' AND is_system=0;
    IF public_group IS NULL THEN
        INSERT INTO model_providers(name,name_en,sort_order,is_active,is_system,remark)
          VALUES ('主播视频','Zhubo Video',20,1,0,'video.zhubo.asia models') RETURNING id INTO public_group;
    END IF;
    SELECT id INTO api_group FROM model_api_providers WHERE name='主播视频' AND is_system=0;
    IF api_group IS NULL THEN
        INSERT INTO model_api_providers(name,name_en,sort_order,is_active,is_system,remark)
          VALUES ('主播视频','Zhubo Video',20,1,0,'video.zhubo.asia models') RETURNING id INTO api_group;
    END IF;
    SELECT id INTO channel_group FROM channel_categories WHERE name='主播视频' AND is_system=0;
    IF channel_group IS NULL THEN
        INSERT INTO channel_categories(name,name_en,sort_order,is_active,is_system)
          VALUES ('主播视频','Zhubo Video',20,1,0) RETURNING id INTO channel_group;
    END IF;
    new_billing := nextval('billing_rules_id_seq');
    SELECT (max(mid::bigint) + 1)::text INTO new_mid FROM models WHERE mid ~ '^[0-9]+$';
    INSERT INTO billing_rules SELECT updated.* FROM jsonb_populate_record(NULL::billing_rules, to_jsonb(billing) || jsonb_build_object(
        'id',new_billing,'pid','','name','Seedance 2.5 Pro CNY 1.06/秒',
        'billing_type','duration','billing_rule','video_resolution','fixed_rate',0,'duration_rate',rate,
        'pricing_tiers',jsonb_build_array(
            jsonb_build_object('resolution','480p','rate',rate,'enabled',true,'cached_rate',0),
            jsonb_build_object('resolution','720p','rate',rate,'enabled',true,'cached_rate',0))::text,
        'extended_config',jsonb_build_object('supported_models',jsonb_build_array('seedance-2.5-pro'),
            'enable_time_multipliers',false,'time_multipliers','[]'::jsonb)::text,
        'created_at',now(),'updated_at',now()
    )) AS updated;
    INSERT INTO models SELECT updated.* FROM jsonb_populate_record(NULL::models, to_jsonb(template) || jsonb_build_object(
        'id',nextval('models_id_seq'),'mid',new_mid,'model_id','seedance-2.5-pro','original_id','seedance-2.5-pro',
        'model_id_alias','','name','Seedance 2.5 Pro','provider_id',public_group,'api_provider_id',api_group,
        'billing_rule_id',new_billing,'pre_deduction',rate * 30,
        'description','4-30秒；480p/720p；最多30图、10视频、10音频参考；参考视频时长不得超过输出时长；1.06元/秒',
        'remark','Zhubo Pro 2026-09-20; sale CNY 1.06/second; exchange=' || exchange,
        'feature_attributes','["文生视频","图生视频","多模态参考生视频"]','created_at',now(),'updated_at',now()
    )) AS updated;
    UPDATE models SET provider_id=public_group,api_provider_id=api_group,updated_at=now()
      WHERE mid IN (SELECT jsonb_array_elements_text(channel.models::jsonb));
    UPDATE channels SET category_id=channel_group,
        models=(models::jsonb || jsonb_build_array(new_mid))::text,
        model_mapping=(coalesce(nullif(model_mapping,''),'{}')::jsonb || jsonb_build_object('seedance-2.5-pro','seedance-2.5-pro'))::text,
        updated_at=now() WHERE id=channel.id;
    UPDATE channel_configs SET category_id=channel_group,updated_at=now()
      WHERE base_url IN ('https://video.zhubo.asia','https://video.zhubo.asia/v1');
END $$;
COMMIT;
SELECT m.model_id,p.name AS public_group,a.name AS api_group,b.billing_type,b.duration_rate,b.pricing_tiers
FROM models m JOIN model_providers p ON p.id=m.provider_id
JOIN model_api_providers a ON a.id=m.api_provider_id JOIN billing_rules b ON b.id=m.billing_rule_id
WHERE p.name='主播视频' ORDER BY m.id;
