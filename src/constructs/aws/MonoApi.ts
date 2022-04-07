import * as cloudfront from "@aws-cdk/aws-cloudfront";
import * as acm from "@aws-cdk/aws-certificatemanager";
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
import { Duration, Fn } from "@aws-cdk/core";
import type { Construct as CdkConstruct } from "@aws-cdk/core";
import type { AwsProvider } from "@lift/providers";
import { AwsConstruct } from "@lift/constructs/abstracts";
import { HttpOrigin } from "@aws-cdk/aws-cloudfront-origins";
import { redirectToMainDomain } from "../../classes/cloudfrontFunctions";
import { getCfnFunctionAssociations } from "../../utils/getDefaultCfnFunctionAssociations";
import type { FromSchema } from "json-schema-to-ts";
import { flatten } from "lodash";
import ServerlessError from "../../utils/error";

export const MONO_API_DEFINITION = {
    type: "object",
    properties: {
        path: { type: "string" },
        domain: {
            anyOf: [
                { type: "string" },
                {
                    type: "array",
                    items: { type: "string" },
                },
            ],
        },
        certificate: { type: "string" },
        functionName: { type: "string" },
        security: {
            type: "object",
            properties: {
                allowIframe: { type: "boolean" },
            },
            additionalProperties: false,
        },
        errorPage: { type: "string" },
        redirectToMainDomain: { type: "boolean" },
    },
    additionalProperties: false,
    required: ["path"],
} as const;

export type MonoApiConfiguration = FromSchema<typeof MONO_API_DEFINITION>;

export class MonoApi extends AwsConstruct {
    public static type = "mono-api";
    public static schema = MONO_API_DEFINITION;

    protected readonly distribution: Distribution;
    protected readonly domains: string[] | undefined;

    constructor(
        scope: CdkConstruct,
        protected readonly id: string,
        protected readonly configuration: MonoApiConfiguration,
        protected readonly provider: AwsProvider
    ) {
        super(scope, id);

        if (configuration.domain !== undefined && configuration.certificate === undefined) {
            throw new ServerlessError(
                `Invalid configuration for the mono api '${id}': if a domain is configured, then a certificate ARN must be configured in the 'certificate' option.\n` +
                "See https://github.com/getlift/lift/blob/master/docs/mono-api.md#custom-domain",
                "LIFT_INVALID_CONSTRUCT_CONFIGURATION"
            );
        }
        if (configuration.functionName !== undefined) {
            throw new ServerlessError(
                `Invalid configuration in 'constructs.${id}.functionName': the function's name is mandatory.`,
                "LIFT_INVALID_CONSTRUCT_CONFIGURATION"
            );
        }

        // Cast the domains to an array
        this.domains = configuration.domain !== undefined ? flatten([configuration.domain]) : undefined;
        const certificate =
            configuration.certificate !== undefined
                ? acm.Certificate.fromCertificateArn(this, "Certificate", configuration.certificate)
                : undefined;

        const backendOriginPolicy = new OriginRequestPolicy(this, "BackendOriginPolicy", {
            originRequestPolicyName: `${this.provider.stackName}-${id}`,
            comment: `Origin request policy for the ${id} website.`,
            cookieBehavior: OriginRequestCookieBehavior.all(),
            queryStringBehavior: OriginRequestQueryStringBehavior.all(),
            headerBehavior: OriginRequestHeaderBehavior.all(),
        });

        const backendCachePolicy = new CachePolicy(this, "BackendCachePolicy", {
            cachePolicyName: `${this.provider.stackName}-${id}`,
            comment: `Cache policy for the ${id} website.`,
            // For the backend we disable all caching by default
            defaultTtl: Duration.seconds(0),
            // Authorization is an exception and must be whitelisted in the Cache Policy
            // This is the reason why we don't use the managed `CachePolicy.CACHING_DISABLED`
            headerBehavior: CacheHeaderBehavior.allowList("Authorization"),
        });

        const lambdaId = this.provider.naming.getLambdaLogicalId(`${this.configuration.functionName}`);
        const lambdaDomain = Fn.join(".", [Fn.ref(lambdaId), `lambda-url.${this.provider.region}.on.aws`]);

        this.distribution = new Distribution(this, "CDN", {
            comment: `${provider.stackName} ${id} mono api CDN`,
            defaultBehavior: {
                // Origins are where CloudFront fetches content
                origin: new HttpOrigin(lambdaDomain, {
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
            // All the assets paths are created in there
            // additionalBehaviors: this.createCacheBehaviors(bucket),
            // errorResponses: this.createErrorResponses(),
            // Enable http2 transfer for better performances
            httpVersion: HttpVersion.HTTP2,
            certificate: certificate,
            domainNames: this.domains,
        });

        const cfnDistribution = this.distribution.node.defaultChild as cloudfront.CfnDistribution;
        const requestFunction = this.createRequestFunction();

        const defaultBehaviorFunctionAssociations = getCfnFunctionAssociations(cfnDistribution);

        cfnDistribution.addOverride("Properties.DistributionConfig.DefaultCacheBehavior.FunctionAssociations", [
            ...defaultBehaviorFunctionAssociations,
            { EventType: FunctionEventType.VIEWER_REQUEST, FunctionARN: requestFunction.functionArn },
        ]);
    }

    private createRequestFunction(): cloudfront.Function {
        let additionalCode = "";

        if (this.configuration.redirectToMainDomain === true) {
            additionalCode += redirectToMainDomain(this.domains);
        }

        /**
         * CloudFront function that redirects nested paths to /index.html and
         * let static files pass.
         *
         * Files extensions list taken from: https://docs.aws.amazon.com/amplify/latest/userguide/redirects.html#redirects-for-single-page-web-apps-spa
         */
        const code = `var REDIRECT_REGEX = /^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|woff|woff2|ttf|map|json)$)([^.]+$)/;

function handler(event) {
    var uri = event.request.uri;
    var request = event.request;
    var isUriToRedirect = REDIRECT_REGEX.test(uri);

    if (isUriToRedirect) {
        request.uri = "/index.html";
    }${additionalCode}

    return event.request;
}`;

        return new cloudfront.Function(this, "RequestFunction", {
            functionName: `${this.provider.stackName}-${this.provider.region}-${this.id}-request`,
            code: cloudfront.FunctionCode.fromInline(code),
        });
    }

    outputs(): Record<string, () => Promise<string | undefined>> {
        return {
            // url: () => this.getUrl(),
            // cname: () => this.getCName(),
        };
    }
}
