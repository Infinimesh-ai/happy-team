import React from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { RoundButton } from '@/components/RoundButton';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { loginTeam } from '@/team/api';

const styles = StyleSheet.create((theme) => ({
    content: {
        flex: 1,
    },
    form: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 24,
        lineHeight: 30,
    },
    subtitle: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.textSecondary,
        fontSize: 12,
        textTransform: 'uppercase',
    },
    input: {
        ...Typography.default(),
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 12,
        fontSize: 16,
        minHeight: 44,
    },
    error: {
        ...Typography.default(),
        color: theme.colors.textDestructive,
        fontSize: 13,
        lineHeight: 18,
    },
    button: {
        marginTop: 4,
    },
    legacyButton: {
        marginTop: 2,
    },
    iconRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));

export default function TeamLoginScreen() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const [email, setEmail] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);

    const submit = async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await loginTeam(email, password);
            await auth.login(result.happyToken, result.secretKey);
            if (result.mustChangePassword) {
                router.replace('/team/change-password');
                return;
            }
            router.replace(result.role === 'ADMIN' ? '/team/admin/users' : '/');
        } catch (e) {
            setError(e instanceof Error ? e.message : t('team.loginFailed'));
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <Stack.Screen options={{ headerShown: true, headerTitle: t('team.loginTitle') }} />
            <KeyboardAvoidingView
                style={styles.content}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList keyboardShouldPersistTaps="handled">
                    <ItemGroup>
                        <View style={styles.form}>
                            <View style={styles.iconRow}>
                                <Ionicons name="business-outline" size={22} color={theme.colors.textSecondary} />
                                <Text style={styles.title}>{t('team.productTitle')}</Text>
                            </View>
                            <Text style={styles.subtitle}>
                                {t('team.loginSubtitle')}
                            </Text>

                            <Text style={styles.label}>{t('team.email')}</Text>
                            <TextInput
                                value={email}
                                onChangeText={setEmail}
                                placeholder={t('team.emailPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="email-address"
                                textContentType="username"
                                style={styles.input}
                            />

                            <Text style={styles.label}>{t('team.password')}</Text>
                            <TextInput
                                value={password}
                                onChangeText={setPassword}
                                placeholder={t('team.password')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                secureTextEntry
                                textContentType="password"
                                style={styles.input}
                            />

                            {error && <Text style={styles.error}>{error}</Text>}

                            <RoundButton
                                title={t('team.signIn')}
                                action={submit}
                                loading={loading}
                                disabled={!email.trim() || !password}
                                style={styles.button}
                            />
                            <RoundButton
                                title={t('navigation.restoreWithSecretKey')}
                                display="inverted"
                                size="normal"
                                style={styles.legacyButton}
                                onPress={() => router.push('/restore/manual')}
                            />
                        </View>
                    </ItemGroup>
                    {auth.isAuthenticated && (
                        <ItemGroup>
                            <View style={styles.form}>
                                <Text style={styles.subtitle}>{t('team.alreadySignedIn')}</Text>
                                <RoundButton
                                    title={t('team.signOut')}
                                    display="inverted"
                                    size="normal"
                                    onPress={() => {
                                        void Modal.confirm(t('team.signOutTitle'), t('team.signOutConfirm'), { confirmText: t('team.signOut'), destructive: true })
                                            .then((confirmed) => confirmed ? auth.logout() : undefined);
                                    }}
                                />
                            </View>
                        </ItemGroup>
                    )}
                </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
