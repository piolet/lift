import { Bucket } from "@aws-cdk/aws-s3";
import {
    AllowedMethods,
    CacheHeaderBehavior,
    CachePolicy,
    Distribution,
    FunctionEventType,
    HttpVersion,
    OriginProtocolPolicy,
    OriginRequestCookieBehavior,
    OriginRequestHeaderBehavior,
    OriginRequestPolicy,
    OriginRequestQueryStringBehavior,
    ViewerProtocolPolicy,
} from "@aws-cdk/aws-cloudfront";
import type { Construct } from "@aws-cdk/core";
import { CfnOutput, Duration, Fn, RemovalPolicy } from "@aws-cdk/core";
import type { FromSchema } from "json-schema-to-ts";
import { HttpOrigin, S3Origin } from "@aws-cdk/aws-cloudfront-origins";
import * as acm from "@aws-cdk/aws-certificatemanager";
import type { BehaviorOptions, ErrorResponse } from "@aws-cdk/aws-cloudfront/lib/distribution";
import * as path from "path";
import * as fs from "fs";
import { flatten } from "lodash";
import * as cloudfront from "@aws-cdk/aws-cloudfront";
import { AwsConstruct } from "@lift/constructs/abstracts";
import type { ConstructCommands } from "@lift/constructs";
import type { AwsProvider } from "@lift/providers";
import { s3Put, s3Sync } from "../../utils/s3-sync";
import { emptyBucket, invalidateCloudFrontCache } from "../../classes/aws";
import ServerlessError from "../../utils/error";
import type { Progress } from "../../utils/logger";
import { getUtils } from "../../utils/logger";

const SCHEMA = {
    type: "object",
    properties: {
        type: { const: "mono-api2" },
        functionName: { type: "string" },
        domain: { type: "string" },
        certificate: { type: "string" },
        forwardedHeaders: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
} as const;

type Configuration = FromSchema<typeof SCHEMA>;

export class MonoApi2 extends AwsConstruct {
    public static type = "mono-api2";
    public static schema = SCHEMA;

    private readonly distribution: Distribution;
    private readonly domains: string[] | undefined;
    private readonly domainOutput: CfnOutput;
    private readonly cnameOutput: CfnOutput;
    private readonly distributionIdOutput: CfnOutput;

    constructor(
        scope: Construct,
        private readonly id: string,
        readonly configuration: Configuration,
        private readonly provider: AwsProvider
    ) {
        super(scope, id);

        if (configuration.domain !== undefined && configuration.certificate === undefined) {
            throw new ServerlessError(
                `Invalid configuration in 'constructs.${id}.certificate': if a domain is configured, then a certificate ARN must be configured as well.`,
                "LIFT_INVALID_CONSTRUCT_CONFIGURATION"
            );
        }

        if (configuration.functionName === undefined) {
            throw new ServerlessError(
                `Invalid configuration in 'constructs.${id}.functionName': functionName is mandatory.`,
                "LIFT_INVALID_CONSTRUCT_CONFIGURATION"
            );
        }

        /**
         * We create custom "Origin Policy" and "Cache Policy" for the backend.
         * "All URL query strings, HTTP headers, and cookies that you include in the cache key (using a cache policy) are automatically included in origin requests. Use the origin request policy to specify the information that you want to include in origin requests, but not include in the cache key."
         * https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/controlling-origin-requests.html
         */
        const backendOriginPolicy = new OriginRequestPolicy(this, "BackendOriginPolicy", {
            originRequestPolicyName: `${this.provider.stackName}-${id}`,
            comment: `Origin request policy for the ${id} api.`,
            cookieBehavior: OriginRequestCookieBehavior.all(),
            queryStringBehavior: OriginRequestQueryStringBehavior.all(),
            headerBehavior: this.headersToForward(),
        });
        const backendCachePolicy = new CachePolicy(this, "BackendCachePolicy", {
            cachePolicyName: `${this.provider.stackName}-${id}`,
            comment: `Cache policy for the ${id} api.`,
            // For the backend we disable all caching by default
            defaultTtl: Duration.seconds(0),
            // Authorization is an exception and must be whitelisted in the Cache Policy
            // This is the reason why we don't use the managed `CachePolicy.CACHING_DISABLED`
            headerBehavior: CacheHeaderBehavior.allowList("Authorization"),
        });

        const lambdaUrl = this.provider.naming.getLambdaFunctionUrlLogicalId(`${this.configuration.functionName}`);

        // Cast the domains to an array
        this.domains = configuration.domain !== undefined ? flatten([configuration.domain]) : undefined;
        const certificate =
            configuration.certificate !== undefined
                ? acm.Certificate.fromCertificateArn(this, "Certificate", configuration.certificate)
                : undefined;

        this.distribution = new Distribution(this, "CDN", {
            comment: `${provider.stackName} ${id} website CDN`,
            defaultBehavior: {
                // Origins are where CloudFront fetches content
                origin: new HttpOrigin(lambdaUrl, {
                    // API Gateway only supports HTTPS
                    protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
                }),
                // For a backend app we all all methods
                allowedMethods: AllowedMethods.ALLOW_ALL,
                cachePolicy: backendCachePolicy,
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                // Forward all values (query strings, headers, and cookies) to the backend app
                // See https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html#managed-origin-request-policies-list
                originRequestPolicy: backendOriginPolicy,
                functionAssociations: [
                    {
                        function: this.createRequestFunction(),
                        eventType: FunctionEventType.VIEWER_REQUEST,
                    },
                ],
            },
            // Enable http2 transfer for better performances
            httpVersion: HttpVersion.HTTP2,
            certificate: certificate,
            domainNames: this.domains,
        });

        let apiDomain = this.configuration.domain ?? this.distribution.distributionDomainName;
        this.domainOutput = new CfnOutput(this, "Domain", {
            description: "Api domain name.",
            value: apiDomain,
        });
        this.cnameOutput = new CfnOutput(this, "CloudFrontCName", {
            description: "CloudFront CNAME.",
            value: this.distribution.distributionDomainName,
        });
        this.distributionIdOutput = new CfnOutput(this, "DistributionId", {
            description: "ID of the CloudFront distribution.",
            value: this.distribution.distributionId,
        });
    }

    outputs(): Record<string, () => Promise<string | undefined>> {
        return {
            url: () => this.getUrl(),
            cname: () => this.getCName(),
        };
    }

    variables(): Record<string, unknown> {
        const domain = this.configuration.domain ?? this.distribution.distributionDomainName;

        return {
            url: Fn.join("", ["https://", domain]),
            cname: this.distribution.distributionDomainName,
        };
    }

    async getUrl(): Promise<string | undefined> {
        const domain = await this.getDomain();
        if (domain === undefined) {
            return undefined;
        }

        return `https://${domain}`;
    }

    async getDomain(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.domainOutput);
    }

    async getCName(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.cnameOutput);
    }

    async getDistributionId(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.distributionIdOutput);
    }

    private headersToForward(): OriginRequestHeaderBehavior {
        let additionalHeadersToForward = this.configuration.forwardedHeaders ?? [];
        if (additionalHeadersToForward.includes("Host")) {
            throw new ServerlessError(
                `Invalid value in 'constructs.${this.id}.forwardedHeaders': the 'Host' header cannot be forwarded (this is an API Gateway limitation). Use the 'X-Forwarded-Host' header in your code instead (it contains the value of the original 'Host' header).`,
                "LIFT_INVALID_CONSTRUCT_CONFIGURATION"
            );
        }
        // `Authorization` cannot be forwarded via this setting (we automatically forward it anyway so we remove it from the list)
        additionalHeadersToForward = additionalHeadersToForward.filter((header: string) => header !== "Authorization");
        if (additionalHeadersToForward.length > 0) {
            if (additionalHeadersToForward.length > 10) {
                throw new ServerlessError(
                    `Invalid value in 'constructs.${this.id}.forwardedHeaders': ${additionalHeadersToForward.length} headers are configured but only 10 headers can be forwarded (this is an CloudFront limitation).`,
                    "LIFT_INVALID_CONSTRUCT_CONFIGURATION"
                );
            }

            // Custom list
            return OriginRequestHeaderBehavior.allowList(...additionalHeadersToForward);
        }

        /**
         * We forward everything except:
         * - `Host` because it messes up API Gateway (that uses the Host to identify which API Gateway to invoke)
         * - `Authorization` because it must be configured on the cache policy
         *   (see https://aws.amazon.com/premiumsupport/knowledge-center/cloudfront-authorization-header/?nc1=h_ls)
         */
        return OriginRequestHeaderBehavior.allowList(
            "Accept",
            "Accept-Language",
            "Content-Type",
            "Origin",
            "Referer",
            "User-Agent",
            "X-Requested-With",
            // This header is set by our CloudFront Function
            "X-Forwarded-Host"
        );
    }

    private createRequestFunction(): cloudfront.Function {
        /**
         * CloudFront function that forwards the real `Host` header into `X-Forwarded-Host`
         *
         * CloudFront does not forward the original `Host` header. We use this
         * to forward the website domain name to the backend app via the `X-Forwarded-Host` header.
         * Learn more: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Forwarded-Host
         */
        const code = `function handler(event) {
    var request = event.request;
    request.headers["x-forwarded-host"] = request.headers["host"];
    return request;
}`;

        return new cloudfront.Function(this, "RequestFunction", {
            functionName: `${this.provider.stackName}-${this.provider.region}-${this.id}-request`,
            code: cloudfront.FunctionCode.fromInline(code),
        });
    }
}
